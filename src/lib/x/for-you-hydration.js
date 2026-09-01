import "server-only";

import { PIPELINE } from "../config.js";
import {
  isQuotePost,
  isRepost,
  passesPostQualityGate,
} from "../ranking.js";
import { lookupPosts } from "./lookup-posts.js";

const X_POST_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const MINIMUM_FEED_POSITION = 1;
const MAXIMUM_FEED_POSITION = 100;

function parseWindowBound(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} must be a valid date.`);
  }

  return date;
}

function isWithinRunWindow(post, windowStart, windowEnd) {
  const createdAt = new Date(post?.created_at);

  return (
    Number.isFinite(createdAt.getTime()) &&
    createdAt >= windowStart &&
    createdAt < windowEnd
  );
}

/**
 * Defensively revalidates the by-value workflow payload before any X lookup.
 * The workflow webhook parser applies the same shape constraints, while this
 * boundary keeps retries bounded if a historical step payload is malformed.
 */
export function normalizeForYouCandidates(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("For You candidates must be an array.");
  }
  if (value.length > PIPELINE.maxCandidates) {
    throw new RangeError(
      `For You candidates cannot exceed ${PIPELINE.maxCandidates} posts.`,
    );
  }

  const seenPostIds = new Set();
  const seenFeedPositions = new Set();

  return value
    .map((candidate, index) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        Object.keys(candidate).length !== 2 ||
        !Object.hasOwn(candidate, "post_id") ||
        !Object.hasOwn(candidate, "feed_position") ||
        typeof candidate.post_id !== "string" ||
        !X_POST_ID_PATTERN.test(candidate.post_id) ||
        !Number.isInteger(candidate.feed_position) ||
        candidate.feed_position < MINIMUM_FEED_POSITION ||
        candidate.feed_position > MAXIMUM_FEED_POSITION
      ) {
        throw new TypeError(`For You candidate ${index + 1} is invalid.`);
      }

      if (seenPostIds.has(candidate.post_id)) {
        throw new TypeError("For You candidate post IDs must be unique.");
      }
      if (seenFeedPositions.has(candidate.feed_position)) {
        throw new TypeError("For You candidate feed positions must be unique.");
      }

      seenPostIds.add(candidate.post_id);
      seenFeedPositions.add(candidate.feed_position);
      return {
        post_id: candidate.post_id,
        feed_position: candidate.feed_position,
      };
    })
    .sort((left, right) => left.feed_position - right.feed_position);
}

/**
 * Adds official-API hydrations after the existing followed/topic collection.
 * Existing API lanes win ID collisions and retain their original positions.
 * Rejected in-window posts remain in the audit snapshot, matching the current
 * search behavior, but only eligible posts proceed to deterministic ranking.
 */
export function mergeHydratedForYouPosts({
  searchResult,
  candidates,
  lookupResult,
  windowStart,
  windowEnd,
}) {
  if (!searchResult || !Array.isArray(searchResult.posts)) {
    throw new TypeError("A valid X search result is required.");
  }
  if (!Array.isArray(searchResult.rankablePosts)) {
    throw new TypeError("The X search result must include rankable posts.");
  }

  const start = parseWindowBound(windowStart, "windowStart");
  const end = parseWindowBound(windowEnd, "windowEnd");
  if (start >= end) {
    throw new RangeError("windowStart must be earlier than windowEnd.");
  }

  const normalizedCandidates = normalizeForYouCandidates(candidates);
  const candidateIds = new Set(
    normalizedCandidates.map((candidate) => candidate.post_id),
  );
  const hydratedById = new Map(
    (Array.isArray(lookupResult?.posts) ? lookupResult.posts : [])
      .filter((post) => candidateIds.has(post?.id))
      .map((post) => [post.id, post]),
  );
  const existingIds = new Set(searchResult.posts.map((post) => post.id));
  const forYouPosts = [];
  const rankableForYouPosts = [];
  let crossChannelDuplicates = 0;
  let outsideWindow = 0;
  let repostsRejected = 0;
  let quotesRejected = 0;
  let viewQualityRejected = 0;

  for (const candidate of normalizedCandidates) {
    const post = hydratedById.get(candidate.post_id);
    if (!post) continue;

    if (existingIds.has(candidate.post_id)) {
      crossChannelDuplicates += 1;
      continue;
    }
    if (!isWithinRunWindow(post, start, end)) {
      outsideWindow += 1;
      continue;
    }

    const positionedPost = {
      ...post,
      source_channel: "for_you",
      search_position: candidate.feed_position,
    };
    forYouPosts.push(positionedPost);

    if (isRepost(positionedPost)) {
      repostsRejected += 1;
    } else if (isQuotePost(positionedPost)) {
      quotesRejected += 1;
    } else if (!passesPostQualityGate(positionedPost)) {
      viewQualityRejected += 1;
    } else {
      rankableForYouPosts.push(positionedPost);
    }
  }

  const hydratedCount = hydratedById.size;
  const unavailableCount = Array.isArray(lookupResult?.unavailableIds)
    ? lookupResult.unavailableIds.filter((id) => candidateIds.has(id)).length
    : 0;
  const unknownCount = Array.isArray(lookupResult?.unknownIds)
    ? lookupResult.unknownIds.filter((id) => candidateIds.has(id)).length
    : 0;

  return {
    ...searchResult,
    posts: [...searchResult.posts, ...forYouPosts],
    rankablePosts: [
      ...searchResult.rankablePosts,
      ...rankableForYouPosts,
    ],
    meta: {
      ...(searchResult.meta || {}),
      resultCount: searchResult.posts.length + forYouPosts.length,
      rawResultCount:
        Number(searchResult.meta?.rawResultCount || 0) + hydratedCount,
      qualityPassed:
        searchResult.rankablePosts.length + rankableForYouPosts.length,
      crossChannelDuplicates:
        Number(searchResult.meta?.crossChannelDuplicates || 0) +
        crossChannelDuplicates,
      forYouRequested: normalizedCandidates.length,
      forYouHydrated: hydratedCount,
      forYouReturned: forYouPosts.length,
      forYouUnavailable: unavailableCount,
      forYouUnknown: unknownCount,
      forYouOutsideWindow: outsideWindow,
      forYouCrossChannelDuplicates: crossChannelDuplicates,
      forYouRepostsRejected: repostsRejected,
      forYouQuotesRejected: quotesRejected,
      forYouViewQualityRejected: viewQualityRejected,
      forYouQualityPassed: rankableForYouPosts.length,
    },
  };
}

/**
 * Uses the existing official X lookup client only when the workflow received
 * browser-discovered candidates. API-only and scheduled runs return the exact
 * original search result object and make no additional request.
 */
export async function hydrateAndMergeForYouPosts({
  searchResult,
  candidates,
  windowStart,
  windowEnd,
  lookup = lookupPosts,
  signal,
}) {
  const normalizedCandidates = normalizeForYouCandidates(candidates);
  if (normalizedCandidates.length === 0) return searchResult;
  if (typeof lookup !== "function") {
    throw new TypeError("An X lookup implementation is required.");
  }

  const lookupResult = await lookup({
    ids: normalizedCandidates.map((candidate) => candidate.post_id),
    signal,
  });

  return mergeHydratedForYouPosts({
    searchResult,
    candidates: normalizedCandidates,
    lookupResult,
    windowStart,
    windowEnd,
  });
}
