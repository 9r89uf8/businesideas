import { X_FOR_YOU_ERROR_CODES } from "./errors.js";

const SAFE_EVENTS = new Set([
  "PERMISSION_APPROVED",
  "PERMISSION_DENIED",
  "AUTH_SESSION_REUSED",
  "AUTH_LOGIN_STARTED",
  "AUTH_LOGIN_SUCCEEDED",
  "AUTH_FAILED",
  "MANUAL_ACTION_REQUIRED",
  "FOR_YOU_SELECTED",
  "POSTS_COLLECTED",
  "NO_FEED_GROWTH",
  "RUN_COMPLETED",
  "RUN_FAILED",
  "CLOUD_RESULT_DELIVERED",
]);
const SAFE_ERROR_CODES = new Set([
  ...Object.values(X_FOR_YOU_ERROR_CODES),
  "ACTION_BLOCKED",
  "AUTH_ACCOUNT_MISMATCH",
  "AUTH_ACCOUNT_UNVERIFIED",
  "AUTH_FAILED",
  "BROWSER_CLOSE_FAILED",
  "COLLECTOR_FAILED",
  "FEED_ERROR",
  "MANUAL_ACTION_REQUIRED",
  "NAVIGATION_BLOCKED",
  "OUTPUT_FAILED",
  "SELECTOR_DRIFT",
  "SESSION_EXPIRED",
]);
const SAFE_LOCATORS = new Set([
  "fill-login-identifier",
  "click-login-next",
  "click-login-use-password",
  "fill-login-username",
  "fill-login-password",
  "click-login-submit",
  "click-for-you",
  "scroll-feed",
  "timeline-post",
  "for-you-tab",
  "for-you-tab[aria-selected=true]",
]);
const SAFE_METHODS = new Set(["existing-session", "credentials", "manual"]);
const SAFE_MODES = new Set(["interactive", "unattended"]);
const SAFE_STOP_REASONS = new Set([
  "TARGET_REACHED",
  "MAXIMUM_SCROLLS",
  "MAXIMUM_RUNTIME",
  "NO_FEED_GROWTH",
  "OUTPUT_FAILED",
  "BROWSER_CLOSE_FAILED",
  ...SAFE_ERROR_CODES,
]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUT_FILE_PATTERN = /^[0-9a-f-]{36}\.posts\.jsonl$/i;

export function isSafeCollectorErrorCode(value) {
  return SAFE_ERROR_CODES.has(value);
}

export function isSafeCollectorStopReason(value) {
  return SAFE_STOP_REASONS.has(value);
}

export function isSafeCollectorAuthMethod(value) {
  return SAFE_METHODS.has(value);
}

function safeFields(fields) {
  const result = {};

  for (const [key, value] of Object.entries(fields || {})) {
    if (
      ["added", "noGrowthCycles", "scrollCycles", "uniquePosts"].includes(key) &&
      Number.isSafeInteger(value) &&
      value >= 0
    ) {
      result[key] = value;
    } else if (key === "errorCode" && isSafeCollectorErrorCode(value)) {
      result.errorCode = value;
    } else if (key === "locator" && SAFE_LOCATORS.has(value)) {
      result.locator = value;
    } else if (key === "method" && isSafeCollectorAuthMethod(value)) {
      result.method = value;
    } else if (key === "mode" && SAFE_MODES.has(value)) {
      result.mode = value;
    } else if (key === "runId" && RUN_ID_PATTERN.test(value)) {
      result.runId = value;
    } else if (key === "outputFile" && OUTPUT_FILE_PATTERN.test(value)) {
      result.outputFile = value;
    } else if (key === "stopReason" && isSafeCollectorStopReason(value)) {
      result.stopReason = value;
    }
  }

  return result;
}

export function createStructuredLogger({
  stream = process.stdout,
  clock = () => new Date(),
} = {}) {
  return (event, fields = {}) => {
    const timestamp = clock();
    stream.write(`${JSON.stringify({
      timestamp:
        timestamp instanceof Date
          ? timestamp.toISOString()
          : new Date(timestamp).toISOString(),
      event: SAFE_EVENTS.has(event) ? event : "UNKNOWN_EVENT",
      ...safeFields(fields),
    })}\n`);
  };
}

export function safeErrorFields(error) {
  const errorCode = isSafeCollectorErrorCode(error?.code)
    ? error.code
    : "COLLECTOR_FAILED";
  return {
    errorCode,
    ...(SAFE_LOCATORS.has(error?.locator) ? { locator: error.locator } : {}),
  };
}
