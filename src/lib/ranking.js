import { PIPELINE } from "./config.js";
import { sha256Hex } from "./sha256.js";

const MAX_POSTS_PER_AUTHOR = 3;
const MINIMUM_POST_LENGTH = 40;

const PROMOTIONAL_LANGUAGE =
  /\b(?:buy\s+now|sale|discount|limited\s+time|subscribe|sign\s+up|use\s+(?:my\s+)?code|link\s+in\s+bio|dm\s+me|free\s+trial|order\s+now)\b/i;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function nonNegativeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : 0;
}

function metricValue(metrics, snakeCaseKey, camelCaseKey) {
  return nonNegativeNumber(metrics?.[snakeCaseKey] ?? metrics?.[camelCaseKey]);
}

function metricsFor(post) {
  return post?.public_metrics ?? post?.publicMetrics ?? post?.metrics ?? {};
}

function postId(post, originalIndex) {
  const value = post?.id ?? post?.post_id ?? post?.x_post_id;

  return typeof value === "string" && value.length > 0
    ? value
    : `missing-id:${originalIndex}`;
}

function authorKey(post, originalIndex) {
  const value = post?.author_id ?? post?.authorId;

  return typeof value === "string" && value.length > 0
    ? value
    : `missing-author:${postId(post, originalIndex)}`;
}

function searchPosition(post, originalIndex) {
  const value = Number(
    post?.search_position ?? post?.searchPosition ?? post?.position,
  );

  return Number.isInteger(value) && value > 0 ? value : originalIndex + 1;
}

function createdAtMilliseconds(post) {
  const value = post?.created_at ?? post?.createdAt ?? post?.x_created_at;
  const milliseconds = new Date(value).getTime();

  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function nowMilliseconds(now) {
  const milliseconds = now instanceof Date ? now.getTime() : new Date(now).getTime();

  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("now must be a valid date or timestamp");
  }

  return milliseconds;
}

function compareRankedPosts(left, right) {
  return (
    right.deterministic_score - left.deterministic_score ||
    right.engagement_velocity - left.engagement_velocity ||
    right.discussion_score - left.discussion_score ||
    right.result_position_score - left.result_position_score ||
    left._searchPosition - right._searchPosition ||
    left._postId.localeCompare(right._postId) ||
    left._originalIndex - right._originalIndex
  );
}

function repeatedAdjacentPhrase(tokens) {
  const maximumPhraseLength = Math.min(8, Math.floor(tokens.length / 2));

  for (let phraseLength = 2; phraseLength <= maximumPhraseLength; phraseLength += 1) {
    for (
      let start = 0;
      start + phraseLength * 2 <= tokens.length;
      start += 1
    ) {
      const first = tokens.slice(start, start + phraseLength).join(" ");
      const second = tokens
        .slice(start + phraseLength, start + phraseLength * 2)
        .join(" ");

      if (first === second && PROMOTIONAL_LANGUAGE.test(first)) {
        return true;
      }
    }
  }

  return false;
}

export function normalizePostText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@\w+/g, "")
    .replace(/#(\w+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function createPostTextHash(text) {
  return sha256Hex(normalizePostText(text));
}

export const hashPostText = createPostTextHash;

export function isRepost(post) {
  if (post?.is_repost === true || post?.isRepost === true) {
    return true;
  }

  const references = post?.referenced_tweets ?? post?.referencedTweets;

  if (
    Array.isArray(references) &&
    references.some((reference) => reference?.type === "retweeted")
  ) {
    return true;
  }

  return typeof post?.text === "string" && /^\s*RT\s+@/i.test(post.text);
}

export function hasObviousRepeatedPromotion(text) {
  if (typeof text !== "string" || !PROMOTIONAL_LANGUAGE.test(text)) {
    return false;
  }

  const fragments = text
    .split(/(?:\r?\n)+|[.!?;]+/)
    .map(normalizePostText)
    .filter((fragment) => fragment.length >= 6);
  const seenFragments = new Set();

  for (const fragment of fragments) {
    if (seenFragments.has(fragment) && PROMOTIONAL_LANGUAGE.test(fragment)) {
      return true;
    }

    seenFragments.add(fragment);
  }

  const tokens = normalizePostText(text).split(" ").filter(Boolean);
  return repeatedAdjacentPhrase(tokens);
}

export function weightedEngagement(metrics = {}) {
  const likes = metricValue(metrics, "like_count", "likeCount");
  const reposts = metricValue(metrics, "retweet_count", "retweetCount");
  const replies = metricValue(metrics, "reply_count", "replyCount");
  const quotes = metricValue(metrics, "quote_count", "quoteCount");

  return likes + 1.5 * reposts + 2 * replies + 3 * quotes;
}

export function engagementVelocity(metrics = {}, ageInHours = 0) {
  const safeAge = Math.max(nonNegativeNumber(ageInHours), 2);
  return Math.log1p(weightedEngagement(metrics)) / safeAge ** 0.35;
}

export function discussionScore(metrics = {}) {
  const replies = metricValue(metrics, "reply_count", "replyCount");
  const quotes = metricValue(metrics, "quote_count", "quoteCount");

  return Math.log1p(replies + 2 * quotes);
}

/**
 * Returns zero-to-one midrank percentiles. Tied values receive the same rank,
 * an all-tied pool receives 0.5, and a singleton receives 1.
 */
export function percentileRanks(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("values must be an array");
  }

  if (values.length === 0) {
    return [];
  }

  if (values.length === 1) {
    return [1];
  }

  const normalizedValues = values.map((value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  });
  const sorted = [...normalizedValues].sort((left, right) => left - right);
  const ranksByValue = new Map();

  for (let start = 0; start < sorted.length; ) {
    let end = start;

    while (end + 1 < sorted.length && sorted[end + 1] === sorted[start]) {
      end += 1;
    }

    ranksByValue.set(sorted[start], (start + end) / 2 / (sorted.length - 1));
    start = end + 1;
  }

  return normalizedValues.map((value) => ranksByValue.get(value));
}

export function resultPositionScore(position, candidateCount) {
  if (candidateCount <= 1) {
    return 1;
  }

  const safePosition = Number.isFinite(Number(position))
    ? Number(position)
    : candidateCount;

  return clamp(1 - (safePosition - 1) / (candidateCount - 1), 0, 1);
}

/**
 * Applies plan sections 5.4-5.5 and returns the selected posts in rank order.
 * Computed values use snake_case so they can be written directly to run_posts.
 */
export function rankPosts(
  posts,
  {
    now = new Date(),
    limit = PIPELINE.defaultAiInputLimit,
    maxPerAuthor = MAX_POSTS_PER_AUTHOR,
  } = {},
) {
  if (!Array.isArray(posts)) {
    throw new TypeError("posts must be an array");
  }

  const effectiveLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;
  const effectiveAuthorLimit =
    Number.isInteger(maxPerAuthor) && maxPerAuthor > 0
      ? maxPerAuthor
      : MAX_POSTS_PER_AUTHOR;

  if (posts.length === 0 || effectiveLimit === 0) {
    return [];
  }

  const currentTime = nowMilliseconds(now);
  const candidateCount = posts.length;
  const candidates = posts.flatMap((post, originalIndex) => {
    const text = typeof post?.text === "string" ? post.text : "";
    const normalizedText = normalizePostText(text);

    if (
      [...text.trim()].length < MINIMUM_POST_LENGTH ||
      normalizedText.length === 0 ||
      isRepost(post) ||
      hasObviousRepeatedPromotion(text)
    ) {
      return [];
    }

    const metrics = metricsFor(post);
    const createdAt = createdAtMilliseconds(post);
    const ageInHours =
      createdAt === null ? 2 : Math.max((currentTime - createdAt) / 3_600_000, 0);
    const originalSearchPosition = searchPosition(post, originalIndex);

    return [
      {
        ...post,
        normalized_text: normalizedText,
        normalized_text_hash: createPostTextHash(normalizedText),
        weighted_engagement: weightedEngagement(metrics),
        engagement_velocity: engagementVelocity(metrics, ageInHours),
        discussion_score: discussionScore(metrics),
        result_position_score: resultPositionScore(
          originalSearchPosition,
          candidateCount,
        ),
        _authorKey: authorKey(post, originalIndex),
        _originalIndex: originalIndex,
        _postId: postId(post, originalIndex),
        _searchPosition: originalSearchPosition,
      },
    ];
  });

  if (candidates.length === 0) {
    return [];
  }

  const velocityPercentiles = percentileRanks(
    candidates.map((candidate) => candidate.engagement_velocity),
  );
  const discussionPercentiles = percentileRanks(
    candidates.map((candidate) => candidate.discussion_score),
  );

  const ranked = candidates
    .map((candidate, index) => {
      const engagementPercentile = velocityPercentiles[index];
      const discussionPercentile = discussionPercentiles[index];

      return {
        ...candidate,
        engagement_velocity_percentile: engagementPercentile,
        discussion_percentile: discussionPercentile,
        deterministic_score:
          0.55 * engagementPercentile +
          0.3 * discussionPercentile +
          0.15 * candidate.result_position_score,
      };
    })
    .sort(compareRankedPosts);

  const seenTextHashes = new Set();
  const postsByAuthor = new Map();
  const selected = [];

  for (const candidate of ranked) {
    if (seenTextHashes.has(candidate.normalized_text_hash)) {
      continue;
    }

    seenTextHashes.add(candidate.normalized_text_hash);

    const authorPostCount = postsByAuthor.get(candidate._authorKey) ?? 0;

    if (authorPostCount >= effectiveAuthorLimit) {
      continue;
    }

    postsByAuthor.set(candidate._authorKey, authorPostCount + 1);

    const {
      _authorKey,
      _originalIndex,
      _postId,
      _searchPosition,
      ...publicCandidate
    } = candidate;
    selected.push(publicCandidate);

    if (selected.length >= effectiveLimit) {
      break;
    }
  }

  return selected;
}

/**
 * Blends ranked discovery channels without treating followed accounts as a
 * quota. Only rankable followed posts are supplied by the X search helper, and
 * they may occupy at most half of the Luna input. Topic posts fill every other
 * available slot while the returned order stays deterministic-score ordered.
 */
export function selectHybridAiInput(rankedPosts, { limit } = {}) {
  if (!Array.isArray(rankedPosts)) {
    throw new TypeError("rankedPosts must be an array");
  }

  const effectiveLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;

  if (effectiveLimit === 0 || rankedPosts.length === 0) {
    return [];
  }

  const followed = rankedPosts
    .filter((post) => post?.source_channel === "followed")
    .slice(0, Math.floor(effectiveLimit / 2));
  const topic = rankedPosts
    .filter((post) => post?.source_channel !== "followed")
    .slice(0, effectiveLimit - followed.length);
  const selected = new Set([...followed, ...topic]);

  return rankedPosts.filter((post) => selected.has(post));
}

export function calculateOpportunityScore({
  deterministic_score,
  deterministicScore,
  commercial_score,
  commercialScore,
  hype_score,
  hypeScore,
} = {}) {
  const deterministic = clamp(
    nonNegativeNumber(deterministic_score ?? deterministicScore),
    0,
    1,
  );
  const commercial =
    clamp(nonNegativeNumber(commercial_score ?? commercialScore), 0, 100) / 100;
  const hype = clamp(nonNegativeNumber(hype_score ?? hypeScore), 0, 100) / 100;

  return 0.4 * deterministic + 0.6 * commercial - 0.3 * hype;
}

export function selectSignals(
  signals,
  {
    limit = PIPELINE.maxSignals,
    minimumCommercialScore = PIPELINE.minimumCommercialScore,
    maximumHypeScore = PIPELINE.maximumHypeScore,
  } = {},
) {
  if (!Array.isArray(signals)) {
    throw new TypeError("signals must be an array");
  }

  const effectiveLimit = Number.isInteger(limit) && limit >= 0 ? limit : 0;

  return signals
    .filter((signal) => {
      const commercial = signal?.commercial_score ?? signal?.commercialScore;
      const hype = signal?.hype_score ?? signal?.hypeScore;

      return (
        signal?.relevant === true &&
        Number.isInteger(commercial) &&
        commercial >= minimumCommercialScore &&
        Number.isInteger(hype) &&
        hype <= maximumHypeScore
      );
    })
    .map((signal, originalIndex) => ({
      ...signal,
      opportunity_score: calculateOpportunityScore(signal),
      _commercialScore:
        signal?.commercial_score ?? signal?.commercialScore,
      _hypeScore: signal?.hype_score ?? signal?.hypeScore,
      _originalIndex: originalIndex,
      _postId: postId(signal, originalIndex),
    }))
    .sort(
      (left, right) =>
        right.opportunity_score - left.opportunity_score ||
        right._commercialScore - left._commercialScore ||
        left._hypeScore - right._hypeScore ||
        left._postId.localeCompare(right._postId) ||
        left._originalIndex - right._originalIndex,
    )
    .slice(0, effectiveLimit)
    .map(
      ({
        _commercialScore,
        _hypeScore,
        _originalIndex,
        _postId,
        ...signal
      }) => signal,
    );
}
