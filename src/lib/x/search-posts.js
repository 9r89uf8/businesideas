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

const MAX_PAGES = 2;
const MAX_RESULTS_PER_PAGE = 100;
const MAX_CANDIDATES = MAX_PAGES * MAX_RESULTS_PER_PAGE;
const MIN_PARTIAL_RESULT_COUNT = 50;
const RECENT_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const FIRST_RUN_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SUCCESSFUL_RUN_OVERLAP_MS = 2 * 60 * 60 * 1_000;
const RECENT_SEARCH_SAFETY_LAG_MS = 30 * 1_000;

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

export const searchPosts = searchRecentPosts;
