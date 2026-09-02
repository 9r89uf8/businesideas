const POST_ID_PATTERN = /^\d{1,19}$/;
const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const STATUS_PATH_PATTERN = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,19})(?:\/|$)/;
const MEDIA_PATH_PATTERNS = Object.freeze({
  "pbs.twimg.com": /^\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//,
  "video.twimg.com": /^\/(?:ext_tw_video|amplify_video|tweet_video)\//,
});
const SAFE_MEDIA_QUERY_PARAMETERS = Object.freeze({
  format: /^(?:gif|jpe?g|png|webp)$/i,
  name: /^(?:thumb|small|medium|large|orig|\d{1,4}x\d{1,4})$/i,
  tag: /^\d{1,4}$/,
});
const MAX_ARTICLE_CANDIDATES_PER_CYCLE = 40;
const ARTICLE_DOM_CALL_TIMEOUT_MS = 5_000;

function articleDomTimeoutError() {
  const error = new Error("A bounded timeline DOM read did not complete.");
  error.code = "SELECTOR_DRIFT";
  error.locator = "timeline-post";
  return error;
}

async function boundedArticleDomCall(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(articleDomTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function optionalString(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

export function normalizeXStatusUrl(value) {
  try {
    const url = new URL(value, "https://x.com");
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        url.hostname,
      )
    ) {
      return null;
    }

    const match = url.pathname.match(STATUS_PATH_PATTERN);
    if (!match) return null;

    return Object.freeze({
      authorHandle: `@${match[1]}`,
      postId: match[2],
      canonicalUrl: `https://x.com/${match[1]}/status/${match[2]}`,
    });
  } catch {
    return null;
  }
}

function normalizeMediaUrls(values) {
  const urls = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        !MEDIA_PATH_PATTERNS[url.hostname]?.test(url.pathname)
      ) {
        continue;
      }
      const safeSearch = new URLSearchParams();
      for (const [name, parameter] of url.searchParams) {
        if (
          SAFE_MEDIA_QUERY_PARAMETERS[name]?.test(parameter)
        ) {
          safeSearch.append(name, parameter);
        }
      }
      url.search = safeSearch.toString();
      url.hash = "";
      const canonical = url.href;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        urls.push(canonical);
      }
    } catch {
      // Ignore malformed or non-HTTPS media URLs from a drifting DOM.
    }
  }

  return urls;
}

export function normalizeExtractedPost(value, { includeRawText = false } = {}) {
  if (!value || typeof value !== "object") return null;

  const status = normalizeXStatusUrl(value.canonicalUrl);
  if (
    !status ||
    !POST_ID_PATTERN.test(String(value.postId || "")) ||
    status.postId !== String(value.postId)
  ) {
    return null;
  }

  const suppliedHandle = optionalString(value.authorHandle)?.replace(/^@/, "");
  if (
    !suppliedHandle ||
    !HANDLE_PATTERN.test(suppliedHandle) ||
    suppliedHandle.toLowerCase() !== status.authorHandle.slice(1).toLowerCase()
  ) {
    return null;
  }

  const createdAtValue = optionalString(value.createdAt);
  const createdAt =
    createdAtValue && Number.isFinite(Date.parse(createdAtValue))
      ? new Date(createdAtValue).toISOString()
      : null;
  const mediaUrls = normalizeMediaUrls(value.mediaUrls);
  const normalized = {
    postId: status.postId,
    canonicalUrl: status.canonicalUrl,
    authorHandle: status.authorHandle,
    authorDisplayName: optionalString(value.authorDisplayName),
    text: optionalString(value.text),
    createdAt,
    hasMedia: mediaUrls.length > 0,
    mediaUrls,
    isRepost: typeof value.isRepost === "boolean" ? value.isRepost : null,
    isPromoted: typeof value.isPromoted === "boolean" ? value.isPromoted : null,
  };

  if (includeRawText) {
    normalized.rawAccessibleText = optionalString(value.rawAccessibleText)?.slice(
      0,
      20_000,
    ) || null;
  }

  return normalized;
}

/**
 * Runs inside the page. Keep it self-contained: Playwright serializes this
 * function and cannot resolve module-scope helpers in the browser process.
 */
export function extractPostFromArticleElement(article, includeRawText) {
  const view = article?.ownerDocument?.defaultView;
  const rect = article?.getBoundingClientRect?.();
  const computedStyle = view?.getComputedStyle?.(article);
  const viewportWidth = view?.innerWidth ||
    article?.ownerDocument?.documentElement?.clientWidth || 0;
  const viewportHeight = view?.innerHeight ||
    article?.ownerDocument?.documentElement?.clientHeight || 0;
  if (
    !rect ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= viewportHeight ||
    rect.left >= viewportWidth ||
    article.hidden ||
    article.getAttribute?.("aria-hidden") === "true" ||
    computedStyle?.display === "none" ||
    computedStyle?.visibility === "hidden" ||
    computedStyle?.contentVisibility === "hidden" ||
    Number(computedStyle?.opacity) === 0
  ) {
    return null;
  }

  const statusPattern = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,19})(?:\/|$)/;
  const embeddedSelector = '[data-testid="card.wrapper"], [data-testid="quoteTweet"]';
  const isEmbedded = (element) => Boolean(element.closest(embeddedSelector));
  const candidates = [];

  for (const anchor of article.querySelectorAll('a[href*="/status/"]')) {
    let parsed;
    try {
      parsed = new URL(anchor.getAttribute("href"), "https://x.com");
    } catch {
      continue;
    }

    if (
      parsed.protocol !== "https:" ||
      parsed.port !== "" ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        parsed.hostname,
      )
    ) {
      continue;
    }
    const match = parsed.pathname.match(statusPattern);
    if (!match) continue;

    candidates.push({
      anchor,
      handle: match[1],
      id: match[2],
      embedded: isEmbedded(anchor),
      hasTime: Boolean(anchor.querySelector("time[datetime]")),
    });
  }

  const primary =
    candidates.find((candidate) => candidate.hasTime && !candidate.embedded) ||
    candidates.find((candidate) => !candidate.embedded);
  if (!primary) return null;

  const time =
    primary.anchor.querySelector("time[datetime]") ||
    [...article.querySelectorAll("time[datetime]")].find(
      (element) => !isEmbedded(element),
    );
  const textElement = [...article.querySelectorAll('[data-testid="tweetText"]')].find(
    (element) => !isEmbedded(element),
  );
  const userElement = article.querySelector('[data-testid="User-Name"]');
  const userLines = (userElement?.innerText || userElement?.textContent || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const displayName = userLines.find(
    (line) =>
      !line.startsWith("@") &&
      line !== "·" &&
      !/^\d+[smhdwy]$/i.test(line),
  ) || null;
  const media = [];

  for (const image of article.querySelectorAll('[data-testid="tweetPhoto"] img')) {
    if (!isEmbedded(image)) media.push(image.currentSrc || image.src || "");
  }
  for (const video of article.querySelectorAll("video[poster]")) {
    if (!isEmbedded(video)) media.push(video.poster || "");
  }

  const socialContext = article.querySelector('[data-testid="socialContext"]');
  const socialText = socialContext?.innerText || socialContext?.textContent || "";
  const promoted = [...article.querySelectorAll("span")].some(
    (span) =>
      !isEmbedded(span) &&
      (span.textContent || "").trim().toLowerCase() === "promoted",
  );
  const rawText = [
    socialText,
    userElement?.innerText || userElement?.textContent || "",
    textElement?.innerText || textElement?.textContent || "",
    promoted ? "Promoted" : "",
  ].filter(Boolean).join("\n");

  return {
    postId: primary.id,
    canonicalUrl: `https://x.com/${primary.handle}/status/${primary.id}`,
    authorHandle: `@${primary.handle}`,
    authorDisplayName: displayName,
    text: textElement?.innerText || textElement?.textContent || null,
    createdAt: time?.getAttribute("datetime") || null,
    mediaUrls: media,
    isRepost: /\breposted\b/i.test(socialText),
    isPromoted: promoted,
    rawAccessibleText: includeRawText ? rawText.slice(0, 20_000) : null,
  };
}

export async function extractVisiblePosts(
  page,
  {
    includeRawText = false,
    maximumPosts = 100,
    knownPostIds = [],
    maximumCandidates = MAX_ARTICLE_CANDIDATES_PER_CYCLE,
    deadlineMs = Number.POSITIVE_INFINITY,
    clock = () => Date.now(),
    assertPermissionActive = () => {},
  } = {},
) {
  if (!Number.isSafeInteger(maximumPosts) || maximumPosts < 1 || maximumPosts > 100) {
    throw new RangeError("maximumPosts must be an integer from 1 to 100.");
  }
  if (
    !Number.isSafeInteger(maximumCandidates) ||
    maximumCandidates < 1 ||
    maximumCandidates > MAX_ARTICLE_CANDIDATES_PER_CYCLE
  ) {
    throw new RangeError(
      `maximumCandidates must be an integer from 1 to ${MAX_ARTICLE_CANDIDATES_PER_CYCLE}.`,
    );
  }
  if (!(deadlineMs === Number.POSITIVE_INFINITY || Number.isFinite(deadlineMs))) {
    throw new TypeError("The extraction deadline is invalid.");
  }
  assertPermissionActive();
  const articles = page.locator('main article[data-testid="tweet"]');
  const initialRemainingMs = deadlineMs - clock();
  if (initialRemainingMs <= 0) return [];
  const discoveredCount = await boundedArticleDomCall(
    articles.count(),
    Math.max(
      1,
      Math.min(ARTICLE_DOM_CALL_TIMEOUT_MS, initialRemainingMs),
    ),
  );
  if (!Number.isSafeInteger(discoveredCount) || discoveredCount < 0) {
    throw articleDomTimeoutError();
  }
  const count = Math.min(discoveredCount, maximumCandidates);
  assertPermissionActive();
  const posts = [];
  const seen = new Set([...knownPostIds].map(String));

  for (let index = 0; index < count; index += 1) {
    assertPermissionActive();
    let remainingMs = deadlineMs - clock();
    if (remainingMs <= 0) break;
    let raw;
    try {
      const article = articles.nth(index);
      if (!(await boundedArticleDomCall(
        article.isVisible(),
        Math.max(1, Math.min(ARTICLE_DOM_CALL_TIMEOUT_MS, remainingMs)),
      ))) continue;
      assertPermissionActive();
      remainingMs = deadlineMs - clock();
      if (remainingMs <= 0) break;
      raw = await boundedArticleDomCall(
        article.evaluate(
          extractPostFromArticleElement,
          includeRawText,
        ),
        Math.max(1, Math.min(ARTICLE_DOM_CALL_TIMEOUT_MS, remainingMs)),
      );
    } catch (error) {
      if (error?.code === "SELECTOR_DRIFT") throw error;
      // Virtualized timelines can detach an article while the cycle is read.
      continue;
    }
    assertPermissionActive();
    const post = normalizeExtractedPost(raw, { includeRawText });
    if (post && !seen.has(post.postId)) {
      seen.add(post.postId);
      posts.push(post);
      if (posts.length >= maximumPosts) break;
    }
  }

  return posts;
}

export async function waitForUnseenPost(
  page,
  knownPostIds,
  {
    timeoutMs = 2_500,
    permissionPollIntervalMs = 250,
    assertPermissionActive = () => {},
  } = {},
) {
  const knownIds = [...knownPostIds];
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    assertPermissionActive();
    const waitSliceMs = Math.max(
      1,
      Math.min(permissionPollIntervalMs, deadline - Date.now()),
    );
    try {
      await page.waitForFunction(
        (knownValues) => {
          const known = new Set(knownValues);
          const pattern = /\/status\/(\d{1,19})(?:\/|$)/;
          const embeddedSelector =
            '[data-testid="card.wrapper"], [data-testid="quoteTweet"]';

          return [...document.querySelectorAll('main article[data-testid="tweet"]')]
            .some((article) => {
              const rect = article.getBoundingClientRect();
              const style = window.getComputedStyle(article);
              if (
                rect.width <= 0 ||
                rect.height <= 0 ||
                rect.bottom <= 0 ||
                rect.right <= 0 ||
                rect.top >= window.innerHeight ||
                rect.left >= window.innerWidth ||
                article.hidden ||
                article.getAttribute("aria-hidden") === "true" ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.contentVisibility === "hidden" ||
                Number(style.opacity) === 0
              ) {
                return false;
              }
              const candidates = [...article.querySelectorAll('a[href*="/status/"]')]
                .map((anchor) => {
                  const match = (anchor.getAttribute("href") || "").match(pattern);
                  return match
                    ? {
                        id: match[1],
                        embedded: Boolean(anchor.closest(embeddedSelector)),
                        hasTime: Boolean(anchor.querySelector("time[datetime]")),
                      }
                    : null;
                })
                .filter(Boolean);
              const primary =
                candidates.find(
                  (candidate) => candidate.hasTime && !candidate.embedded,
                ) || candidates.find((candidate) => !candidate.embedded);
              return primary && !known.has(primary.id);
            });
        },
        knownIds,
        { timeout: waitSliceMs },
      );
    } catch {
      continue;
    }
    assertPermissionActive();
    return true;
  }

  assertPermissionActive();
  return false;
}
