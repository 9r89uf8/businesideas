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
import { PIPELINE } from "../config.js";
import { passesPostQualityGate } from "../ranking.js";

const MAX_PAGES = 2;
const MAX_RESULTS_PER_PAGE = 100;
const MIN_RESULTS_PER_PAGE = 10;
const MAX_CANDIDATES = PIPELINE.maxCandidates;
const MIN_PARTIAL_RESULT_COUNT = 50;
const MAX_FOLLOWED_USERNAMES = 50;
const MAX_X_QUERY_LENGTH = 512;
const MAX_TOPIC_FALLBACK_SHARE = 0.2;
const RECENT_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const RESEARCH_WINDOW_MS =
  PIPELINE.researchWindowHours * 60 * 60 * 1_000;
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
 * Uses a rolling three-day default and X recent-search's seven-day boundary.
 * Explicit bounds are preserved so workflow retries query the stored window.
 */
export function getRecentSearchWindow({
  startTime,
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
  } else {
    requestedStart = new Date(end.getTime() - RESEARCH_WINDOW_MS);
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

  const query = `${FOLLOWED_AI_QUERY} (${authors}) -is:retweet -is:quote`;

  if (query.length > MAX_X_QUERY_LENGTH) {
    throw new RangeError("The followed-account X query exceeds 512 characters.");
  }

  return query;
}

/**
 * Splits the complete configured account list into X queries without dropping
 * valid usernames or exceeding the recent-search query-length limit.
 */
export function buildFollowedAccountsQueries(usernames) {
  const normalized = normalizeFollowedUsernames(usernames);
  const queries = [];
  let batch = [];

  for (const username of normalized) {
    const candidateBatch = [...batch, username];

    try {
      buildFollowedAccountsQuery(candidateBatch);
      batch = candidateBatch;
    } catch (error) {
      if (!(error instanceof RangeError) || batch.length === 0) {
        throw error;
      }

      queries.push(buildFollowedAccountsQuery(batch));
      batch = [username];
    }
  }

  if (batch.length > 0) {
    queries.push(buildFollowedAccountsQuery(batch));
  }

  return queries;
}

/**
 * Followed accounts are a discovery preference, not a quality exemption.
 * They must clear the same raw-view floor as topic-discovery posts.
 */
export function isEligiblePost(post) {
  return passesPostQualityGate(post);
}

export const isStrongFollowedPost = isEligiblePost;

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
      Math.max(MIN_RESULTS_PER_PAGE, remaining),
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

async function searchFollowedAccountBatches({
  queries,
  startTime,
  endTime,
  limit,
  fetchImpl,
  signal,
}) {
  const posts = [];
  const seenIds = new Set();
  let rawResultCount = 0;
  let duplicateCount = 0;
  let pagesFetched = 0;
  let partial = false;
  let partialError = null;
  let windowStart = null;
  let windowEnd = null;

  for (
    let index = 0;
    index < queries.length && rawResultCount < limit;
    index += 1
  ) {
    const remainingQueries = queries.length - index;
    const remainingRawBudget = limit - rawResultCount;
    const reservedForLaterBatches =
      MIN_RESULTS_PER_PAGE * (remainingQueries - 1);
    const batchLimit = Math.max(
      1,
      remainingRawBudget - reservedForLaterBatches,
    );
    const result = await searchRecentPosts({
      query: queries[index],
      startTime,
      endTime,
      limit: batchLimit,
      fetchImpl,
      signal,
    });

    rawResultCount += result.posts.length;
    pagesFetched += result.meta.pagesFetched;
    partial ||= result.partial;
    partialError ||= result.partialError;
    windowStart ||= result.meta.windowStart;
    windowEnd ||= result.meta.windowEnd;

    for (const post of result.posts) {
      if (seenIds.has(post.id)) {
        duplicateCount += 1;
        continue;
      }
      seenIds.add(post.id);
      posts.push({
        ...post,
        search_position: posts.length + 1,
      });
    }
  }

  return {
    posts,
    rawResultCount,
    duplicateCount,
    pagesFetched,
    partial,
    partialError,
    windowStart,
    windowEnd,
  };
}

/**
 * Retrieves followed-account candidates first across query-length-safe batches.
 * Configured accounts may fill the entire candidate pool. Topic discovery is a
 * bounded fallback that can use only unfilled capacity and at most one fifth of
 * the run limit.
 *
 * `rankablePosts` contains only posts from either lane that clear the view floor.
 * `posts` is the bounded snapshot stored for inspection: it contains every
 * rankable post, then rejected followed-account candidates, then rejected topic
 * fallback candidates.
 */
export async function searchHybridRecentPosts({
  query,
  followedUsernames = [],
  startTime,
  endTime,
  qualityTime,
  candidateLimit = MAX_CANDIDATES,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const requestedCandidateLimit = normalizeLimit(candidateLimit);
  const metricsCapturedAt =
    qualityTime === undefined
      ? new Date()
      : parseTime(qualityTime, "qualityTime");
  const normalizedUsernames = normalizeFollowedUsernames(followedUsernames);
  const followedRequestedLimit = normalizedUsernames.length
    ? requestedCandidateLimit
    : 0;
  const followedQueries = buildFollowedAccountsQueries(normalizedUsernames);
  let followedResult = null;

  if (followedQueries.length > 0 && followedRequestedLimit > 0) {
    followedResult = await searchFollowedAccountBatches({
      queries: followedQueries,
      startTime,
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
    isEligiblePost(post),
  );
  const unfilledCandidateSlots =
    requestedCandidateLimit - (followedResult?.rawResultCount || 0);
  const maximumTopicFallback = Math.ceil(
    requestedCandidateLimit * MAX_TOPIC_FALLBACK_SHARE,
  );
  const availableTopicFallback = Math.min(
    unfilledCandidateSlots,
    maximumTopicFallback,
  );
  const topicRequestedLimit = followedResult?.partial
    ? 0
    : followedQueries.length
      ? availableTopicFallback >= MIN_RESULTS_PER_PAGE
        ? availableTopicFallback
        : 0
      : requestedCandidateLimit;
  const topicResult = topicRequestedLimit > 0
    ? await searchRecentPosts({
        query,
        startTime,
        endTime,
        limit: topicRequestedLimit,
        fetchImpl,
        signal,
      })
    : null;
  const followedIds = new Set(followedPosts.map((post) => post.id));
  const followedQualityIds = new Set(
    followedQualityPosts.map((post) => post.id),
  );
  const topicPosts = (topicResult?.posts || [])
    .filter((post) => !followedIds.has(post.id))
    .map((post) => ({
      ...post,
      source_channel: "topic",
    }));
  const topicQualityPosts = topicPosts.filter(isEligiblePost);
  const rankablePosts = [...followedQualityPosts, ...topicQualityPosts].slice(
    0,
    requestedCandidateLimit,
  );
  const rankableIds = new Set(rankablePosts.map((post) => post.id));
  const failedFollowedPosts = followedPosts.filter(
    (post) => !followedQualityIds.has(post.id) && !rankableIds.has(post.id),
  );
  const failedTopicPosts = topicPosts.filter(
    (post) => !rankableIds.has(post.id),
  );
  const posts = [
    ...rankablePosts,
    ...failedFollowedPosts,
    ...failedTopicPosts,
  ]
    .slice(0, requestedCandidateLimit)
    .map((post, index) => ({
      ...post,
      search_position: index + 1,
    }));
  const searchPositions = new Map(
    posts.map((post) => [post.id, post.search_position]),
  );
  const positionedRankablePosts = rankablePosts.map((post) => ({
    ...post,
    search_position: searchPositions.get(post.id) || post.search_position,
  }));

  return {
    posts,
    rankablePosts: positionedRankablePosts,
    partial: Boolean(followedResult?.partial || topicResult?.partial),
    partialError: followedResult?.partialError || topicResult?.partialError,
    meta: {
      resultCount: posts.length,
      rawResultCount:
        (followedResult?.rawResultCount || 0) + (topicResult?.posts.length || 0),
      requestedLimit: requestedCandidateLimit,
      windowStart:
        followedResult?.windowStart || topicResult?.meta.windowStart,
      windowEnd: followedResult?.windowEnd || topicResult?.meta.windowEnd,
      metricsCapturedAt: metricsCapturedAt.toISOString(),
      followedAccountsConfigured: normalizedUsernames.length,
      followedQueryBatches: followedQueries.length,
      followedRequestedLimit,
      followedReturned: followedPosts.length,
      followedBatchDuplicates: followedResult?.duplicateCount || 0,
      followedQualityPassed: followedQualityPosts.length,
      topicRequestedLimit,
      topicReturned: topicPosts.length,
      topicQualityPassed: topicQualityPosts.length,
      qualityPassed: rankablePosts.length,
      crossChannelDuplicates:
        (topicResult?.posts || []).filter((post) => followedIds.has(post.id)).length,
      pagesFetched:
        (followedResult?.pagesFetched || 0) +
        (topicResult?.meta.pagesFetched || 0),
    },
  };
}

export const searchPosts = searchRecentPosts;
