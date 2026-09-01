import { isSafeCollectorErrorCode } from "./for-you/logging.js";

const AUTH_STATES = new Set([
  "healthy",
  "manual_login_required",
  "unknown",
]);
const MANUAL_LOGIN_ERROR_CODES = new Set([
  "MANUAL_ACTION_REQUIRED",
  "SESSION_EXPIRED",
  "AUTH_FAILED",
  "AUTH_ACCOUNT_MISMATCH",
  "AUTH_ACCOUNT_UNVERIFIED",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeXForYouAuthState(value) {
  return AUTH_STATES.has(value) ? value : "unknown";
}

export function normalizeXForYouErrorCode(value) {
  return isSafeCollectorErrorCode(value) ? value : null;
}

export function connectionObservationFromCloudResult(result) {
  if (result?.status === "completed") {
    return Object.freeze({ authState: "healthy", errorCode: null });
  }

  if (result?.status === "failed") {
    const errorCode = normalizeXForYouErrorCode(result.errorCode);
    return Object.freeze({
      authState: MANUAL_LOGIN_ERROR_CODES.has(errorCode)
        ? "manual_login_required"
        : "unknown",
      errorCode,
    });
  }

  return Object.freeze({ authState: "unknown", errorCode: null });
}

export function isValidXForYouConnectionObservation(value) {
  if (!isPlainObject(value)) return false;

  const { authState, errorCode } = value;
  if (!AUTH_STATES.has(authState)) return false;
  if (authState === "healthy") return errorCode === null;
  if (authState === "manual_login_required") {
    return MANUAL_LOGIN_ERROR_CODES.has(errorCode);
  }
  return (
    errorCode === null ||
    (isSafeCollectorErrorCode(errorCode) &&
      !MANUAL_LOGIN_ERROR_CODES.has(errorCode))
  );
}

export function buildXForYouConnectionCounts(
  existingCounts,
  observation,
  checkedAt,
) {
  if (
    !isValidXForYouConnectionObservation(observation) ||
    typeof checkedAt !== "string" ||
    !Number.isFinite(Date.parse(checkedAt))
  ) {
    throw new TypeError("Invalid X For You connection status.");
  }

  const counts = isPlainObject(existingCounts) ? existingCounts : {};
  return Object.freeze({
    ...counts,
    x_for_you_auth_state: observation.authState,
    x_for_you_checked_at: checkedAt,
    x_for_you_error_code: observation.errorCode,
    ...(observation.authState === "healthy"
      ? { x_for_you_success_at: checkedAt }
      : {}),
  });
}
