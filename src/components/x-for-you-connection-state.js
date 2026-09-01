import {
  normalizeXForYouAuthState,
  normalizeXForYouErrorCode,
} from "../lib/x/for-you-connection.js";

function normalizedTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function latestTimestamp(...values) {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

export function normalizeXForYouRun(run) {
  const counts = run?.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    return null;
  }

  const checkedAt = normalizedTimestamp(counts.x_for_you_checked_at);
  if (!checkedAt) return null;

  const authState = normalizeXForYouAuthState(
    counts.x_for_you_auth_state,
  );
  const successAt = normalizedTimestamp(counts.x_for_you_success_at);
  const errorCode = normalizeXForYouErrorCode(counts.x_for_you_error_code);

  return Object.freeze({
    authState,
    checkedAt,
    successAt,
    errorCode,
  });
}

export function describeXForYouConnection({
  latestCheckedRun = null,
  latestHealthyRun = null,
  unavailable = false,
} = {}) {
  const checked = normalizeXForYouRun(latestCheckedRun);
  const healthy = normalizeXForYouRun(latestHealthyRun);
  const successAt = latestTimestamp(
    checked?.successAt,
    checked?.authState === "healthy" ? checked.checkedAt : null,
    healthy?.successAt,
    healthy?.authState === "healthy" ? healthy.checkedAt : null,
  );

  if (unavailable) {
    return Object.freeze({
      state: "unknown",
      label: "Status unavailable",
      detail: "The X For You connection status could not be loaded.",
      checkedAt: null,
      successAt,
      errorCode: null,
    });
  }

  if (!checked) {
    return Object.freeze({
      state: "unknown",
      label: "Not checked yet",
      detail: "No cloud connection check has been recorded yet.",
      checkedAt: null,
      successAt,
      errorCode: null,
    });
  }

  if (checked.authState === "healthy") {
    return Object.freeze({
      state: "healthy",
      label: "Healthy",
      detail: "The approved X account was verified by the latest cloud check.",
      checkedAt: checked.checkedAt,
      successAt,
      errorCode: null,
    });
  }

  if (checked.authState === "manual_login_required") {
    return Object.freeze({
      state: "manual_login_required",
      label: "Manual login required",
      detail: "X needs the approved account to be verified before For You can run.",
      checkedAt: checked.checkedAt,
      successAt,
      errorCode: checked.errorCode,
    });
  }

  return Object.freeze({
    state: "unknown",
    label: "Could not verify",
    detail: "The latest cloud check could not confirm the X connection.",
    checkedAt: checked.checkedAt,
    successAt,
    errorCode: checked.errorCode,
  });
}
