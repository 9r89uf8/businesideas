import {
  assertVerifiedCapability,
} from "./preflight.js";
import { closeBrowserContext } from "./browser-close.js";
import { launchAuthorizedChrome } from "./browser.js";
import { collectForYouPosts } from "./collect.js";
import { saveFailureDiagnostics } from "./diagnostics.js";
import { selectForYouFeed } from "./feed.js";
import {
  ensureXAuthenticated,
  requireAuthenticatedAccount,
} from "./login.js";
import { safeErrorFields } from "./logging.js";
import { installNavigationGuard } from "./navigation.js";
import { createJsonlOutput, writeRunMetadata } from "./output.js";
import { validateCollectorRuntimeOptions } from "./runtime-options.js";

function failureStopReason(error) {
  return safeErrorFields(error).errorCode;
}

function outputFailure() {
  const error = new Error("The collector output could not be persisted.");
  error.code = "OUTPUT_FAILED";
  return error;
}

function dateFromClock(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Collector clock is invalid.");
  return date;
}

export async function runAuthorizedCollector({
  capability,
  env = process.env,
  options,
  log = () => {},
  clock = () => new Date(),
} = {}) {
  const authorized = assertVerifiedCapability(capability, {
    now: dateFromClock(clock),
  });
  const runtimeOptions = validateCollectorRuntimeOptions(options);
  const runId = authorized.runId;
  const startedAt = authorized.startedAt;
  let browserContext = null;
  let page = null;
  let assertNoUnexpectedPages = () => true;
  let output = null;
  let authenticatedUsing = null;
  let scrollCycles = 0;
  let stopReason = null;
  let uniquePosts = 0;
  let primaryError = null;
  let postsFileName = null;
  let metadataFileName = null;
  const candidates = [];

  try {
    try {
      output = await createJsonlOutput({
        outputDirectory: authorized.runtimePaths.outputDirectory,
        runId,
      });
    } catch {
      throw outputFailure();
    }
    postsFileName = output.fileName;

    const launched = await launchAuthorizedChrome(capability, { clock });
    browserContext = launched.context;
    page = launched.page;
    assertNoUnexpectedPages = launched.assertNoUnexpectedPages;
    const navigationGuard = await installNavigationGuard(page, {
      browserContext,
      allowSameOriginLoginRedirects: true,
    });
    const assertPermissionActive = () => {
      assertVerifiedCapability(capability, { now: dateFromClock(clock) });
      assertNoUnexpectedPages();
      navigationGuard.assertSafe();
    };

    authenticatedUsing = await ensureXAuthenticated(page, {
      env,
      interactiveChallenges: runtimeOptions.interactiveChallenges,
      manualActionTimeoutMs: runtimeOptions.manualActionTimeoutMs,
      stateTimeoutMs: runtimeOptions.stateTimeoutMs,
      assertPermissionActive,
      log,
    });
    navigationGuard.completeLogin();
    assertPermissionActive();
    await requireAuthenticatedAccount(page, authorized.configuredAccount, {
      timeoutMs: runtimeOptions.stateTimeoutMs,
      assertPermissionActive,
    });
    assertPermissionActive();
    await selectForYouFeed(page, {
      timeoutMs: runtimeOptions.stateTimeoutMs,
      assertPermissionActive,
      log,
    });
    assertPermissionActive();

    const collected = await collectForYouPosts(page, {
      limits: {
        targetUniquePosts: authorized.requestedPostLimit,
        maximumScrolls: runtimeOptions.maximumScrolls,
        maximumNoGrowthCycles: runtimeOptions.maximumNoGrowthCycles,
        maximumRuntimeMs: runtimeOptions.maximumRuntimeMs,
        loadWaitMs: runtimeOptions.loadWaitMs,
      },
      includeRawText: runtimeOptions.includeRawText,
      assertAuthenticatedAccount: async () => {
        assertPermissionActive();
        await requireAuthenticatedAccount(page, authorized.configuredAccount, {
          timeoutMs: runtimeOptions.stateTimeoutMs,
          assertPermissionActive,
        });
        assertPermissionActive();
      },
      assertPermissionActive,
      clock: () => dateFromClock(clock).getTime(),
      log,
      onPost: async (post) => {
        try {
          await output.writePost({ runId, ...post });
        } catch {
          throw outputFailure();
        }
        uniquePosts += 1;
        candidates.push(Object.freeze({
          postId: post.postId,
          feedPosition: post.feedPosition,
        }));
      },
    });
    assertPermissionActive();
    scrollCycles = collected.scrollCycles;
    stopReason = collected.stopReason;
  } catch (error) {
    primaryError = error;
    stopReason = failureStopReason(error);
    const authorizationDisallowsPageAccess = [
      "FEATURE_DISABLED",
      "CONFIG_INVALID",
      "APPROVED_ACCOUNT_MISMATCH",
    ].includes(error?.code);
    if (page && !authorizationDisallowsPageAccess) {
      try {
        await saveFailureDiagnostics({
          page,
          outputDirectory: authorized.runtimePaths.outputDirectory,
          runId,
          error,
          postsCollected: uniquePosts,
          saveScreenshot: runtimeOptions.saveFailureScreenshot,
          assertPermissionActive: () =>
            assertVerifiedCapability(capability, {
              now: dateFromClock(clock),
            }),
        });
      } catch {
        // Diagnostics cannot turn a bounded collector failure into a retry.
      }
    }
  }

  try {
    await closeBrowserContext(browserContext);
  } catch (closeError) {
    // Always surface this over an earlier error so command.js knows the
    // persistent-profile lock must not be released.
    primaryError = closeError;
    stopReason = closeError.code;
  }
  try {
    await output?.close();
  } catch {
    if (primaryError?.code !== "BROWSER_CLOSE_FAILED") {
      primaryError = outputFailure();
      stopReason = "OUTPUT_FAILED";
    }
  }

  const completedAt = dateFromClock(clock).toISOString();
  const metadata = Object.freeze({
    runId,
    approvedAccount: authorized.approvedAccount,
    startedAt,
    completedAt,
    requestedPosts: authorized.requestedPostLimit,
    uniquePosts,
    scrollCycles,
    stopReason,
    authenticatedUsing,
    failureCategory: primaryError ? failureStopReason(primaryError) : null,
  });

  try {
    const metadataOutput = await writeRunMetadata({
      outputDirectory: authorized.runtimePaths.outputDirectory,
      runId,
      metadata,
    });
    metadataFileName = metadataOutput.fileName;
  } catch {
    primaryError ||= outputFailure();
  }

  if (primaryError) throw primaryError;

  log("RUN_COMPLETED", {
    runId,
    uniquePosts,
    scrollCycles,
    stopReason,
    outputFile: postsFileName,
  });
  return Object.freeze({
    metadata,
    postsFileName,
    metadataFileName,
    candidates: Object.freeze(candidates),
  });
}
