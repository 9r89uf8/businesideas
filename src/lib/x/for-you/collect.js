import {
  performReadOnlyAction,
  X_READ_ONLY_ACTIONS,
} from "./action-policy.js";
import {
  extractVisiblePosts,
  waitForUnseenPost,
} from "./extract-post.js";
import { assertForYouSelected } from "./feed.js";
import { requireAllowedXPage, requireXHomePage } from "./navigation.js";
import {
  detectXPageState,
  feedHasVisibleError,
  X_PAGE_STATES,
} from "./page-state.js";

export const COLLECTION_STOP_REASONS = Object.freeze({
  TARGET_REACHED: "TARGET_REACHED",
  MAXIMUM_SCROLLS: "MAXIMUM_SCROLLS",
  MAXIMUM_RUNTIME: "MAXIMUM_RUNTIME",
  NO_FEED_GROWTH: "NO_FEED_GROWTH",
});

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function normalizeScrollLimits(limits = {}) {
  return Object.freeze({
    targetUniquePosts: boundedInteger(
      limits.targetUniquePosts,
      "targetUniquePosts",
      1,
      100,
    ),
    maximumScrolls: boundedInteger(
      limits.maximumScrolls ?? 60,
      "maximumScrolls",
      0,
      200,
    ),
    maximumNoGrowthCycles: boundedInteger(
      limits.maximumNoGrowthCycles ?? 5,
      "maximumNoGrowthCycles",
      1,
      20,
    ),
    maximumRuntimeMs: boundedInteger(
      limits.maximumRuntimeMs ?? 300_000,
      "maximumRuntimeMs",
      1_000,
      900_000,
    ),
    loadWaitMs: boundedInteger(
      limits.loadWaitMs ?? 2_500,
      "loadWaitMs",
      250,
      30_000,
    ),
  });
}

function collectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function assertCollectiblePage(
  page,
  assertPermissionActive,
  assertAuthenticatedAccount,
) {
  requireAllowedXPage(page);

  assertPermissionActive();
  const state = await detectXPageState(page);
  assertPermissionActive();
  if (state === X_PAGE_STATES.CHALLENGE) {
    throw collectionError(
      "MANUAL_ACTION_REQUIRED",
      "X presented a verification challenge during collection.",
    );
  }
  if (
    state === X_PAGE_STATES.LOGIN_REQUIRED ||
    state === X_PAGE_STATES.USERNAME_REQUIRED ||
    state === X_PAGE_STATES.PASSWORD_REQUIRED
  ) {
    throw collectionError(
      "SESSION_EXPIRED",
      "The authenticated X session expired during collection.",
    );
  }
  assertPermissionActive();
  if (await feedHasVisibleError(page)) {
    throw collectionError("FEED_ERROR", "X reported a feed loading error.");
  }
  assertPermissionActive();
  await assertAuthenticatedAccount();
  assertPermissionActive();
  requireXHomePage(page);
  await assertForYouSelected(page, { assertPermissionActive });
}

export async function collectForYouPosts(
  page,
  {
    limits,
    includeRawText = false,
    onPost = async () => {},
    assertPermissionActive = () => {},
    assertAuthenticatedAccount = async () => {},
    clock = () => Date.now(),
    log = () => {},
  },
) {
  const normalizedLimits = normalizeScrollLimits(limits);
  const startedAtMs = clock();
  const postsById = new Map();
  let scrollCycles = 0;
  let noGrowthCycles = 0;
  let stopReason = null;

  while (stopReason === null) {
    assertPermissionActive();
    if (clock() - startedAtMs >= normalizedLimits.maximumRuntimeMs) {
      stopReason = COLLECTION_STOP_REASONS.MAXIMUM_RUNTIME;
      break;
    }
    await assertCollectiblePage(
      page,
      assertPermissionActive,
      assertAuthenticatedAccount,
    );

    const visiblePosts = await extractVisiblePosts(page, {
      includeRawText,
      maximumPosts:
        normalizedLimits.targetUniquePosts - postsById.size,
      knownPostIds: postsById.keys(),
      deadlineMs: startedAtMs + normalizedLimits.maximumRuntimeMs,
      clock,
      assertPermissionActive,
    });
    let addedThisCycle = 0;

    for (const post of visiblePosts) {
      if (postsById.has(post.postId)) continue;

      assertPermissionActive();

      const observed = Object.freeze({
        ...post,
        observedAt: new Date(clock()).toISOString(),
        feedPosition: postsById.size + 1,
      });
      postsById.set(post.postId, observed);
      await onPost(observed);
      addedThisCycle += 1;

      if (postsById.size >= normalizedLimits.targetUniquePosts) break;
    }

    noGrowthCycles = addedThisCycle > 0 ? 0 : noGrowthCycles + 1;
    if (addedThisCycle > 0) {
      log("POSTS_COLLECTED", {
        added: addedThisCycle,
        uniquePosts: postsById.size,
      });
    }

    if (postsById.size >= normalizedLimits.targetUniquePosts) {
      stopReason = COLLECTION_STOP_REASONS.TARGET_REACHED;
      break;
    }
    if (clock() - startedAtMs >= normalizedLimits.maximumRuntimeMs) {
      stopReason = COLLECTION_STOP_REASONS.MAXIMUM_RUNTIME;
      break;
    }
    if (noGrowthCycles >= normalizedLimits.maximumNoGrowthCycles) {
      stopReason = COLLECTION_STOP_REASONS.NO_FEED_GROWTH;
      log("NO_FEED_GROWTH", { noGrowthCycles });
      break;
    }
    if (scrollCycles >= normalizedLimits.maximumScrolls) {
      stopReason = COLLECTION_STOP_REASONS.MAXIMUM_SCROLLS;
      break;
    }

    assertPermissionActive();
    await performReadOnlyAction(page, X_READ_ONLY_ACTIONS.SCROLL_FEED);
    scrollCycles += 1;
    const remainingRuntimeMs = Math.max(
      0,
      normalizedLimits.maximumRuntimeMs - (clock() - startedAtMs),
    );
    if (remainingRuntimeMs === 0) {
      stopReason = COLLECTION_STOP_REASONS.MAXIMUM_RUNTIME;
      break;
    }
    await waitForUnseenPost(page, postsById.keys(), {
      timeoutMs: Math.min(normalizedLimits.loadWaitMs, remainingRuntimeMs),
      assertPermissionActive,
    });
  }

  return Object.freeze({
    posts: Object.freeze([...postsById.values()]),
    scrollCycles,
    stopReason,
  });
}
