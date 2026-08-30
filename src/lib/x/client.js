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
]);

export const X_EXPANSIONS = Object.freeze(["author_id"]);
export const X_USER_FIELDS = Object.freeze(["username"]);

const SAFE_INTEGER_PATTERN = /^\d{1,19}$/;

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

export function normalizeXPost(post, usersById = new Map()) {
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
