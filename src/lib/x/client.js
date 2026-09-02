import "server-only";

export const X_API_BASE_URL = "https://api.x.com";

export const X_POST_FIELDS = Object.freeze([
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "lang",
  "public_metrics",
  "referenced_tweets",
  "entities",
  "note_tweet",
  "article",
  "attachments",
  "media_metadata",
]);

export const X_EXPANSIONS = Object.freeze([
  "author_id",
  "attachments.media_keys",
  "article.cover_media",
  "article.media_entities",
]);
export const X_USER_FIELDS = Object.freeze(["username"]);
export const X_MEDIA_FIELDS = Object.freeze([
  "media_key",
  "type",
  "alt_text",
]);

const SAFE_INTEGER_PATTERN = /^\d{1,19}$/;
const SAFE_MEDIA_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_TYPES = new Set(["animated_gif", "photo", "video"]);
const MAX_CONTEXT_URLS = 8;
const MAX_CONTEXT_MEDIA = 8;
const MAX_CONTEXT_URL_LENGTH = 2_048;
const MAX_CONTEXT_TITLE_LENGTH = 500;
const MAX_CONTEXT_DESCRIPTION_LENGTH = 2_000;
const MAX_CONTEXT_TEXT_LENGTH = 12_000;
const MAX_CONTEXT_ALT_TEXT_LENGTH = 2_000;

/**
 * An error safe to surface in workflow logs. It deliberately excludes the
 * request headers, bearer token, query string, and upstream response body.
 */
export class XApiError extends Error {
  constructor(
    message,
    {
      status = null,
      retryAfterMs = null,
      rateLimitResetAt = null,
      rateLimitResetEpochSeconds = null,
    } = {},
  ) {
    super(message);
    this.name = "XApiError";
    this.status = status;
    this.isRateLimited = status === 429;
    this.retryAfterMs = retryAfterMs;
    this.rateLimitResetAt = rateLimitResetAt;
    this.rateLimitResetEpochSeconds = rateLimitResetEpochSeconds;
  }
}

function parseRetryAfter(value, nowMs) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }

  return null;
}

function readRetryMetadata(headers) {
  const nowMs = Date.now();
  const resetValue = headers.get("x-rate-limit-reset");
  const resetSeconds = Number(resetValue);
  const hasValidReset =
    typeof resetValue === "string" &&
    resetValue.trim() !== "" &&
    Number.isFinite(resetSeconds) &&
    resetSeconds >= 0;
  const resetMs = hasValidReset ? resetSeconds * 1_000 : null;
  const resetWaitMs = resetMs === null ? null : Math.max(0, resetMs - nowMs);
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"), nowMs);
  const waits = [resetWaitMs, retryAfterMs].filter((value) => value !== null);
  const effectiveRetryAfterMs = waits.length > 0 ? Math.max(...waits) : null;

  return {
    retryAfterMs: effectiveRetryAfterMs,
    rateLimitResetAt:
      resetMs === null ? null : new Date(resetMs).toISOString(),
    rateLimitResetEpochSeconds: hasValidReset ? resetSeconds : null,
  };
}

function requireBearerToken() {
  const token = process.env.X_BEARER_TOKEN?.trim();

  if (!token) {
    throw new XApiError("X API server configuration is missing.");
  }

  return token;
}

function createRequestUrl(path, searchParams) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("X API paths must be absolute pathnames.");
  }

  const url = new URL(path, X_API_BASE_URL);

  if (url.origin !== X_API_BASE_URL) {
    throw new TypeError("X API requests must use the configured X origin.");
  }

  if (searchParams) {
    url.search = new URLSearchParams(searchParams).toString();
  }

  return url;
}

/**
 * Performs one authenticated X API v2 GET request.
 *
 * Callers may inject fetch for isolated tests. Production calls always read the
 * bearer token at request time, keeping it server-only and out of cached output.
 */
export async function xRequest(
  path,
  { searchParams, signal, fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  const url = createRequestUrl(path, searchParams);
  const bearerToken = requireBearerToken();
  let response;

  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      cache: "no-store",
      signal,
    });
  } catch {
    throw new XApiError("X API request could not be completed.");
  }

  let payload = null;
  try {
    const body = await response.text();
    payload = body ? JSON.parse(body) : {};
  } catch {
    const retryMetadata = readRetryMetadata(response.headers);
    throw new XApiError("X API returned an invalid response.", {
      status: response.status,
      ...retryMetadata,
    });
  }

  if (!response.ok) {
    const retryMetadata = readRetryMetadata(response.headers);
    throw new XApiError(`X API request failed with status ${response.status}.`, {
      status: response.status,
      ...retryMetadata,
    });
  }

  return payload;
}

export function normalizeXId(value, label = "X ID") {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must not be supplied as an unsafe number.`);
  }

  const id =
    typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? String(value).trim()
      : "";

  if (!SAFE_INTEGER_PATTERN.test(id)) {
    throw new TypeError(`${label} must be a 1 to 19 digit string.`);
  }

  return id;
}

function normalizeMetric(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function boundedText(value, maximumLength) {
  if (typeof value !== "string") return null;

  const normalized = value.replaceAll("\0", "").trim();
  return normalized ? normalized.slice(0, maximumLength) : null;
}

function normalizeContextUrl(value) {
  if (typeof value !== "string") return null;
  const candidate = value.replaceAll("\0", "").trim();
  if (!candidate || candidate.length > MAX_CONTEXT_URL_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/u.test(candidate)) return null;

  try {
    const url = new URL(candidate);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function normalizeUrlEntity(entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
    return null;
  }

  const url = [entity.unwound_url, entity.expanded_url, entity.url]
    .map(normalizeContextUrl)
    .find(Boolean);
  if (!url) return null;

  return {
    url,
    title: boundedText(entity.title, MAX_CONTEXT_TITLE_LENGTH),
    description: boundedText(
      entity.description,
      MAX_CONTEXT_DESCRIPTION_LENGTH,
    ),
  };
}

function normalizeContextUrls(entities) {
  const byUrl = new Map();

  for (const entity of Array.isArray(entities?.urls) ? entities.urls : []) {
    const normalized = normalizeUrlEntity(entity);
    if (!normalized) continue;

    const existing = byUrl.get(normalized.url);
    if (existing) {
      existing.title ||= normalized.title;
      existing.description ||= normalized.description;
      continue;
    }

    byUrl.set(normalized.url, normalized);
    if (byUrl.size >= MAX_CONTEXT_URLS) break;
  }

  return [...byUrl.values()];
}

function normalizeMediaKey(value) {
  const key = typeof value === "string" ? value.trim() : "";
  return SAFE_MEDIA_KEY_PATTERN.test(key) ? key : null;
}

function normalizedMediaRecord(media, mediaKey) {
  return {
    media_key: mediaKey,
    type: MEDIA_TYPES.has(media?.type) ? media.type : null,
    alt_text: boundedText(media?.alt_text, MAX_CONTEXT_ALT_TEXT_LENGTH),
  };
}

export function indexMedia(mediaItems) {
  const mediaByKey = new Map();

  for (const media of Array.isArray(mediaItems) ? mediaItems : []) {
    const mediaKey = normalizeMediaKey(media?.media_key);
    if (!mediaKey) continue;

    const normalized = normalizedMediaRecord(media, mediaKey);
    const existing = mediaByKey.get(mediaKey);
    if (!existing) {
      mediaByKey.set(mediaKey, normalized);
      continue;
    }

    existing.type ||= normalized.type;
    existing.alt_text ||= normalized.alt_text;
  }

  return mediaByKey;
}

function collectMediaKeys(value, target) {
  if (Array.isArray(value)) {
    for (const item of value) collectMediaKeys(item, target);
    return;
  }

  const directKey = normalizeMediaKey(value);
  if (directKey) {
    target.push(directKey);
    return;
  }

  if (!value || typeof value !== "object") return;
  const nestedKey = normalizeMediaKey(value.media_key);
  if (nestedKey) target.push(nestedKey);
}

function indexPostMediaMetadata(mediaMetadata) {
  const metadataByKey = new Map();

  for (const metadata of Array.isArray(mediaMetadata) ? mediaMetadata : []) {
    const mediaKey = normalizeMediaKey(metadata?.media_key);
    if (!mediaKey) continue;
    metadataByKey.set(mediaKey, normalizedMediaRecord(metadata, mediaKey));
  }

  return metadataByKey;
}

function normalizeMediaContext(mediaKeys, metadataByKey, mediaByKey) {
  const normalized = [];
  const seen = new Set();

  for (const value of mediaKeys) {
    const mediaKey = normalizeMediaKey(value);
    if (!mediaKey || seen.has(mediaKey)) continue;
    seen.add(mediaKey);

    const expanded = mediaByKey.get(mediaKey);
    const metadata = metadataByKey.get(mediaKey);
    normalized.push({
      media_key: mediaKey,
      type: expanded?.type || metadata?.type || null,
      alt_text: metadata?.alt_text || expanded?.alt_text || null,
    });

    if (normalized.length >= MAX_CONTEXT_MEDIA) break;
  }

  return normalized;
}

function normalizeNoteTweet(post) {
  const note = post?.note_tweet ?? post?.note_post;
  if (!note || typeof note !== "object" || Array.isArray(note)) return null;

  const text = boundedText(note.text, MAX_CONTEXT_TEXT_LENGTH);
  const urls = normalizeContextUrls(note.entities);
  return text || urls.length ? { text, urls } : null;
}

function normalizeArticle(post, metadataByKey, mediaByKey) {
  const article = post?.article;
  const articleObject =
    article && typeof article === "object" && !Array.isArray(article)
      ? article
      : {};
  const suppliedTitle =
    typeof post?.article_title === "string"
      ? post.article_title
      : post?.article_title?.text ?? post?.article_title?.title;
  const title = boundedText(
    articleObject.title ?? suppliedTitle,
    MAX_CONTEXT_TITLE_LENGTH,
  );
  const description = boundedText(
    articleObject.description ??
      articleObject.preview_text ??
      articleObject.summary,
    MAX_CONTEXT_DESCRIPTION_LENGTH,
  );
  const text = boundedText(
    articleObject.text ?? articleObject.plain_text,
    MAX_CONTEXT_TEXT_LENGTH,
  );
  const urls = normalizeContextUrls(articleObject.entities);
  const mediaKeys = [];
  collectMediaKeys(articleObject.cover_media_key, mediaKeys);
  collectMediaKeys(articleObject.cover_media, mediaKeys);
  collectMediaKeys(articleObject.media_keys, mediaKeys);
  collectMediaKeys(articleObject.media_entities, mediaKeys);
  const media = normalizeMediaContext(mediaKeys, metadataByKey, mediaByKey);

  return title || description || text || urls.length || media.length
    ? { title, description, text, urls, media }
    : null;
}

function normalizeSourceContext(post, mediaByKey) {
  const metadataByKey = indexPostMediaMetadata(post?.media_metadata);
  const attachmentKeys = [];
  collectMediaKeys(post?.attachments?.media_keys, attachmentKeys);
  for (const mediaKey of metadataByKey.keys()) attachmentKeys.push(mediaKey);

  return {
    urls: normalizeContextUrls(post?.entities),
    note_tweet: normalizeNoteTweet(post),
    article: normalizeArticle(post, metadataByKey, mediaByKey),
    media: normalizeMediaContext(
      attachmentKeys,
      metadataByKey,
      mediaByKey,
    ),
  };
}

export function indexUsers(users) {
  const usersById = new Map();

  for (const user of Array.isArray(users) ? users : []) {
    try {
      const id = normalizeXId(user?.id, "X user ID");
      usersById.set(id, {
        id,
        username:
          typeof user?.username === "string" && user.username.trim()
            ? user.username.trim().replace(/^@/, "")
            : null,
      });
    } catch {
      // A malformed expansion must not discard otherwise valid post data.
    }
  }

  return usersById;
}

export function normalizeXPost(
  post,
  usersById = new Map(),
  mediaByKey = new Map(),
) {
  const id = normalizeXId(post?.id, "X post ID");
  const authorId = normalizeXId(post?.author_id, "X author ID");
  const conversationId =
    post?.conversation_id === undefined || post.conversation_id === null
      ? null
      : normalizeXId(post.conversation_id, "X conversation ID");
  const username = usersById.get(authorId)?.username ?? null;
  const metrics = post?.public_metrics ?? {};
  const referencedTweets = Array.isArray(post?.referenced_tweets)
    ? post.referenced_tweets.flatMap((reference) => {
        if (
          !reference ||
          !["retweeted", "quoted", "replied_to"].includes(reference.type)
        ) {
          return [];
        }

        try {
          return [{
            type: reference.type,
            id: normalizeXId(reference.id, "Referenced X post ID"),
          }];
        } catch {
          return [];
        }
      })
    : [];

  return {
    id,
    text: typeof post?.text === "string" ? post.text : "",
    author_id: authorId,
    created_at:
      typeof post?.created_at === "string" ? post.created_at : null,
    conversation_id: conversationId,
    lang: typeof post?.lang === "string" ? post.lang : null,
    referenced_tweets: referencedTweets,
    source_context: normalizeSourceContext(post, mediaByKey),
    public_metrics: {
      impression_count: normalizeMetric(metrics.impression_count),
      reply_count: normalizeMetric(metrics.reply_count),
      like_count: normalizeMetric(metrics.like_count),
      bookmark_count: normalizeMetric(metrics.bookmark_count),
    },
    author_username: username,
    url: username
      ? `https://x.com/${encodeURIComponent(username)}/status/${id}`
      : `https://x.com/i/web/status/${id}`,
  };
}

export function safeXErrorMetadata(error) {
  if (!(error instanceof XApiError)) {
    return {
      status: null,
      retryAfterMs: null,
      rateLimitResetAt: null,
      rateLimitResetEpochSeconds: null,
    };
  }

  return {
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    rateLimitResetAt: error.rateLimitResetAt,
    rateLimitResetEpochSeconds: error.rateLimitResetEpochSeconds,
  };
}
