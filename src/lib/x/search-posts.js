import "server-only";

import {
  X_EXPANSIONS,
  X_POST_FIELDS,
  X_USER_FIELDS,
  indexUsers,
  normalizeXPost,
  safeXErrorMetadata,
  xRequest,
} from "./client.js";
import { passesFollowedQualityGate } from "../ranking.js";

const MAX_PAGES = 2;
const MAX_RESULTS_PER_PAGE = 100;
const MAX_CANDIDATES = MAX_PAGES * MAX_RESULTS_PER_PAGE;
const MIN_PARTIAL_RESULT_COUNT = 50;
const MAX_FOLLOWED_USERNAMES = 12;
const MAX_X_QUERY_LENGTH = 512;
const RECENT_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SUCCESSFUL_RUN_OVERLAP_MS = 2 * 60 * 60 * 1_000;
const RECENT_SEARCH_SAFETY_LAG_MS = 30 * 1_000;
const X_USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,15}$/;
const FOLLOWED_AI_QUERY =
  '(AI OR "artificial intelligence" OR "generative AI" OR "inteligencia artificial" OR ChatGPT OR Claude OR Gemini OR "AI agent" OR "agente de IA" OR GenAI OR LLM)';

function parseTime(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid date.`);
  }

  return date;
}

function toXTime(date) {
  return new Date(Math.floor(date.getTime() / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}

/**
 * Applies the first-run default and X recent-search's seven-day boundary.
 * A caller can supply the overlap-adjusted start from the last successful run.
 */
export function getRecentSearchWindow({
  startTime,
  previousWindowEnd,
  endTime,
  currentTime,
} = {}) {
  const now =
    currentTime === undefined
      ? new Date()
      : parseTime(currentTime, "currentTime");
  const requestedEnd =
    endTime === undefined ? now : parseTime(endTime, "endTime");
  const latestAllowedEnd = new Date(
    now.getTime() - RECENT_SEARCH_SAFETY_LAG_MS,
  );
  const end =
    requestedEnd > latestAllowedEnd ? latestAllowedEnd : requestedEnd;
  let requestedStart;

  if (startTime !== undefined) {
    requestedStart = parseTime(startTime, "startTime");
  } else if (previousWindowEnd !== undefined) {
    const previousEnd = parseTime(previousWindowEnd, "previousWindowEnd");
    requestedStart = new Date(
      previousEnd.getTime() - SUCCESSFUL_RUN_OVERLAP_MS,
    );
  } else {
    requestedStart = new Date(end.getTime() - FIRST_RUN_WINDOW_MS);
  }

  const earliestAllowed = new Date(end.getTime() - RECENT_SEARCH_WINDOW_MS);
  const start =
    requestedStart < earliestAllowed ? earliestAllowed : requestedStart;

  if (start >= end) {
    throw new RangeError("startTime must be earlier than endTime.");
  }

  return {
    startTime: toXTime(start),
    endTime: toXTime(end),
  };
}

function normalizeLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("limit must be a positive integer.");
  }

  return Math.min(limit, MAX_CANDIDATES);
}

/**
 * X usernames are case-insensitive and limited to 15 ASCII letters, numbers,
 * or underscores. Invalid values are discarded so settings can never inject
 * additional search operators into the followed-account query.
 */
export function normalizeFollowedUsernames(usernames) {
  if (!Array.isArray(usernames)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();

  for (const value of usernames) {
    const username =
      typeof value === "string"
        ? value.trim().replace(/^@+/, "").toLowerCase()
        : "";

    if (!X_USERNAME_PATTERN.test(username) || seen.has(username)) {
      continue;
    }

    seen.add(username);
    normalized.push(username);

    if (normalized.length >= MAX_FOLLOWED_USERNAMES) {
      break;
    }
  }

  return normalized;
}

export function buildFollowedAccountsQuery(usernames) {
  const normalized = normalizeFollowedUsernames(usernames);

  if (normalized.length === 0) {
    return null;
  }

  const authors = normalized
    .map((username) => `from:${username}`)
    .join(" OR ");

  const query = `${FOLLOWED_AI_QUERY} (${authors}) -is:retweet`;

  if (query.length > MAX_X_QUERY_LENGTH) {
    throw new RangeError("The followed-account X query exceeds 512 characters.");
  }

  return query;
}

/**
 * Followed accounts are a discovery preference, not a quality exemption.
 * A post needs real view reach, either strong on its own or supported by
 * comments, likes, and saves. Repost and quote counts are ignored. This keeps
 * quiet/random posts from displacing topic evidence solely because of author.
 */
export function isStrongFollowedPost(post, options) {
  return passesFollowedQualityGate(post, options);
}

function readPagePosts(payload) {
  if (payload?.data === undefined) {
    if (payload?.meta?.result_count === 0) {
      return [];
    }

    throw new Error("X recent search returned an invalid data payload.");
  }

  if (!Array.isArray(payload.data)) {
    throw new Error("X recent search returned an invalid data payload.");
  }

  const usersById = indexUsers(payload?.includes?.users);
  return payload.data.map((post) => normalizeXPost(post, usersById));
}

/**
 * Retrieves up to two relevancy-sorted pages from X recent search.
 *
 * A second-page failure is returned as a partial result only when the first
 * page supplied at least 50 usable posts, as required by the workflow policy.
 */
export async function searchRecentPosts({
  query,
  startTime,
  previousWindowEnd,
  endTime,
  limit = MAX_CANDIDATES,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof query !== "string" || !query.trim()) {
    throw new TypeError("query must be a non-empty string.");
  }

  const requestedLimit = normalizeLimit(limit);
  const window = getRecentSearchWindow({
    startTime,
    previousWindowEnd,
    endTime,
  });
  const posts = [];
  const seenIds = new Set();
  let nextToken = null;
  let pagesFetched = 0;
  let partial = false;
  let partialError = null;

  for (let page = 0; page < MAX_PAGES && posts.length < requestedLimit; page += 1) {
    const remaining = requestedLimit - posts.length;
    const maxResults = Math.min(
      MAX_RESULTS_PER_PAGE,
      Math.max(10, remaining),
    );
    const searchParams = {
      query: query.trim(),
      start_time: window.startTime,
      end_time: window.endTime,
      max_results: String(maxResults),
      sort_order: "relevancy",
      "tweet.fields": X_POST_FIELDS.join(","),
      expansions: X_EXPANSIONS.join(","),
      "user.fields": X_USER_FIELDS.join(","),
    };

    if (nextToken) {
      searchParams.next_token = nextToken;
    }

    let payload;
    let pagePosts;
    try {
      payload = await xRequest("/2/tweets/search/recent", {
        searchParams,
        fetchImpl,
        signal,
      });
      pagePosts = readPagePosts(payload);
    } catch (error) {
      if (page > 0 && posts.length >= MIN_PARTIAL_RESULT_COUNT) {
        partial = true;
        partialError = safeXErrorMetadata(error);
        break;
      }

      throw error;
    }

    pagesFetched += 1;

    for (const post of pagePosts) {
      if (seenIds.has(post.id)) {
        continue;
      }

      seenIds.add(post.id);
      posts.push({
        ...post,
        search_position: posts.length + 1,
      });

      if (posts.length >= requestedLimit) {
        break;
      }
    }

    nextToken =
      typeof payload?.meta?.next_token === "string" &&
      payload.meta.next_token
        ? payload.meta.next_token
        : null;

    if (!nextToken || pagePosts.length === 0) {
      break;
    }
  }

  return {
    posts,
    partial,
    partialError,
    meta: {
      resultCount: posts.length,
      pagesFetched,
      requestedLimit,
      nextToken,
      windowStart: window.startTime,
      windowEnd: window.endTime,
    },
  };
}

/**
 * Retrieves followed-account candidates first, then spends every remaining
 * candidate slot on the editable topic query. The followed request is bounded
 * by half the AI input size, so it cannot reduce topic discovery by more than
 * the number of Luna slots it could actually occupy.
 *
 * `rankablePosts` contains qualifying followed posts plus topic discovery.
 * `posts` is the bounded snapshot stored for inspection: it contains every
 * rankable post and uses any spare capacity for failed followed candidates.
 */
export async function searchHybridRecentPosts({
  query,
  followedUsernames = [],
  startTime,
  previousWindowEnd,
  endTime,
  qualityTime,
  candidateLimit = MAX_CANDIDATES,
  aiInputLimit = 100,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const requestedCandidateLimit = normalizeLimit(candidateLimit);
  const metricsCapturedAt =
    qualityTime === undefined
      ? new Date()
      : parseTime(qualityTime, "qualityTime");
  const normalizedUsernames = normalizeFollowedUsernames(followedUsernames);
  const normalizedAiInputLimit =
    Number.isInteger(aiInputLimit) && aiInputLimit > 0
      ? Math.min(aiInputLimit, requestedCandidateLimit)
      : 0;
  const followedRequestedLimit = Math.min(
    Math.floor(normalizedAiInputLimit / 2),
    Math.floor(requestedCandidateLimit / 2),
  );
  const followedQuery = buildFollowedAccountsQuery(normalizedUsernames);
  let followedResult = null;

  if (followedQuery && followedRequestedLimit > 0) {
    followedResult = await searchRecentPosts({
      query: followedQuery,
      startTime,
      previousWindowEnd,
      endTime,
      limit: followedRequestedLimit,
      fetchImpl,
      signal,
    });
  }

  const followedPosts = (followedResult?.posts || []).map((post) => ({
    ...post,
    source_channel: "followed",
  }));
  const followedQualityPosts = followedPosts.filter((post) =>
    isStrongFollowedPost(post, { now: metricsCapturedAt }),
  );
  const topicRequestedLimit =
    requestedCandidateLimit - followedQualityPosts.length;
  const topicResult = await searchRecentPosts({
    query,
    startTime,
    previousWindowEnd,
    endTime,
    limit: topicRequestedLimit,
    fetchImpl,
    signal,
  });
  const followedIds = new Set(followedPosts.map((post) => post.id));
  const followedQualityIds = new Set(
    followedQualityPosts.map((post) => post.id),
  );
  const topicPosts = topicResult.posts
    .filter((post) => !followedQualityIds.has(post.id))
    .map((post) => ({
      ...post,
      source_channel: "topic",
    }));
  const rankablePosts = [...followedQualityPosts, ...topicPosts].slice(
    0,
    requestedCandidateLimit,
  );
  const rankableIds = new Set(rankablePosts.map((post) => post.id));
  const failedFollowedPosts = followedPosts.filter(
    (post) => !followedQualityIds.has(post.id) && !rankableIds.has(post.id),
  );
  const posts = [...rankablePosts, ...failedFollowedPosts].slice(
    0,
    requestedCandidateLimit,
  );

  return {
    posts,
    rankablePosts,
    partial: Boolean(followedResult?.partial || topicResult.partial),
    partialError: followedResult?.partialError || topicResult.partialError,
    meta: {
      resultCount: posts.length,
      rawResultCount:
        followedPosts.length + topicResult.posts.length,
      requestedLimit: requestedCandidateLimit,
      windowStart:
        followedResult?.meta.windowStart || topicResult.meta.windowStart,
      windowEnd: followedResult?.meta.windowEnd || topicResult.meta.windowEnd,
      metricsCapturedAt: metricsCapturedAt.toISOString(),
      followedAccountsConfigured: normalizedUsernames.length,
      followedRequestedLimit: followedQuery ? followedRequestedLimit : 0,
      followedReturned: followedPosts.length,
      followedQualityPassed: followedQualityPosts.length,
      topicRequestedLimit,
      topicReturned: topicPosts.length,
      crossChannelDuplicates:
        topicResult.posts.filter((post) => followedIds.has(post.id)).length,
      pagesFetched:
        (followedResult?.meta.pagesFetched || 0) +
        topicResult.meta.pagesFetched,
    },
  };
}

export const searchPosts = searchRecentPosts;
