import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  describeXForYouConnection,
  normalizeXForYouRun,
} from "../src/components/x-for-you-connection-state.js";
import {
  buildXForYouConnectionCounts,
  connectionObservationFromCloudResult,
  isValidXForYouConnectionObservation,
} from "../src/lib/x/for-you-connection.js";

function runWithCounts(counts) {
  return { id: "run-1", counts };
}

test("cloud callback results map to bounded connection observations", () => {
  assert.deepEqual(
    connectionObservationFromCloudResult({ status: "completed" }),
    { authState: "healthy", errorCode: null },
  );

  for (const errorCode of [
    "MANUAL_ACTION_REQUIRED",
    "SESSION_EXPIRED",
    "AUTH_FAILED",
    "AUTH_ACCOUNT_MISMATCH",
    "AUTH_ACCOUNT_UNVERIFIED",
  ]) {
    assert.deepEqual(
      connectionObservationFromCloudResult({ status: "failed", errorCode }),
      { authState: "manual_login_required", errorCode },
    );
  }

  assert.deepEqual(
    connectionObservationFromCloudResult({
      status: "failed",
      errorCode: "NAVIGATION_BLOCKED",
    }),
    { authState: "unknown", errorCode: "NAVIGATION_BLOCKED" },
  );
  assert.deepEqual(
    connectionObservationFromCloudResult({
      status: "failed",
      errorCode: "password=do-not-render",
    }),
    { authState: "unknown", errorCode: null },
  );
  assert.deepEqual(
    connectionObservationFromCloudResult({
      status: "failed",
      errorCode: "UNKNOWN_UPPERCASE_CODE",
    }),
    { authState: "unknown", errorCode: null },
  );
  assert.deepEqual(connectionObservationFromCloudResult(null), {
    authState: "unknown",
    errorCode: null,
  });
});

test("connection status persistence preserves counts and enforces state/code pairs", () => {
  const checkedAt = "2026-09-01T18:00:00.000Z";
  assert.deepEqual(
    buildXForYouConnectionCounts(
      { x_returned: 42, x_for_you_success_at: "2026-08-31T17:00:00.000Z" },
      {
        authState: "manual_login_required",
        errorCode: "SESSION_EXPIRED",
      },
      checkedAt,
    ),
    {
      x_returned: 42,
      x_for_you_auth_state: "manual_login_required",
      x_for_you_checked_at: checkedAt,
      x_for_you_error_code: "SESSION_EXPIRED",
      x_for_you_success_at: "2026-08-31T17:00:00.000Z",
    },
  );
  assert.deepEqual(
    buildXForYouConnectionCounts(
      { x_returned: 42, x_for_you_error_code: "SESSION_EXPIRED" },
      { authState: "healthy", errorCode: null },
      checkedAt,
    ),
    {
      x_returned: 42,
      x_for_you_auth_state: "healthy",
      x_for_you_checked_at: checkedAt,
      x_for_you_error_code: null,
      x_for_you_success_at: checkedAt,
    },
  );

  for (const invalid of [
    { authState: "healthy", errorCode: "SESSION_EXPIRED" },
    { authState: "manual_login_required", errorCode: "NAVIGATION_BLOCKED" },
    { authState: "unknown", errorCode: "AUTH_FAILED" },
  ]) {
    assert.equal(isValidXForYouConnectionObservation(invalid), false);
    assert.throws(
      () => buildXForYouConnectionCounts({}, invalid, checkedAt),
      /Invalid X For You connection status/,
    );
  }
});

test("healthy X For You checks present their check as the latest success", () => {
  const status = describeXForYouConnection({
    latestCheckedRun: runWithCounts({
      x_for_you_auth_state: "healthy",
      x_for_you_checked_at: "2026-09-01T12:30:00-05:00",
      x_for_you_success_at: "2026-09-01T12:30:00-05:00",
      x_for_you_error_code: "IGNORED_ON_SUCCESS",
    }),
  });

  assert.deepEqual(status, {
    state: "healthy",
    label: "Healthy",
    detail: "The approved X account was verified by the latest cloud check.",
    checkedAt: "2026-09-01T17:30:00.000Z",
    successAt: "2026-09-01T17:30:00.000Z",
    errorCode: null,
  });
});

test("manual-login status preserves the most recent healthy check", () => {
  const status = describeXForYouConnection({
    latestCheckedRun: runWithCounts({
      x_for_you_auth_state: "manual_login_required",
      x_for_you_checked_at: "2026-09-01T18:00:00.000Z",
      x_for_you_error_code: "MANUAL_ACTION_REQUIRED",
    }),
    latestHealthyRun: runWithCounts({
      x_for_you_auth_state: "healthy",
      x_for_you_checked_at: "2026-08-31T17:00:00.000Z",
      x_for_you_success_at: "2026-08-31T17:00:00.000Z",
    }),
  });

  assert.equal(status.state, "manual_login_required");
  assert.equal(status.label, "Manual login required");
  assert.equal(status.checkedAt, "2026-09-01T18:00:00.000Z");
  assert.equal(status.successAt, "2026-08-31T17:00:00.000Z");
  assert.equal(status.errorCode, "MANUAL_ACTION_REQUIRED");
});

test("unknown and malformed values fail closed without exposing arbitrary text", () => {
  const normalized = normalizeXForYouRun(runWithCounts({
    x_for_you_auth_state: "secret-state",
    x_for_you_checked_at: "2026-09-01T18:00:00.000Z",
    x_for_you_success_at: "not-a-date",
    x_for_you_error_code: "password=do-not-render",
  }));
  const status = describeXForYouConnection({
    latestCheckedRun: runWithCounts({
      x_for_you_auth_state: "secret-state",
      x_for_you_checked_at: "2026-09-01T18:00:00.000Z",
      x_for_you_error_code: "password=do-not-render",
    }),
  });

  assert.deepEqual(normalized, {
    authState: "unknown",
    checkedAt: "2026-09-01T18:00:00.000Z",
    successAt: null,
    errorCode: null,
  });
  assert.equal(status.state, "unknown");
  assert.equal(status.label, "Could not verify");
  assert.equal(status.errorCode, null);
});

test("missing or invalid check timestamps present a neutral never-checked state", () => {
  for (const latestCheckedRun of [
    null,
    runWithCounts(null),
    runWithCounts({
      x_for_you_auth_state: "manual_login_required",
      x_for_you_checked_at: "invalid",
    }),
  ]) {
    const status = describeXForYouConnection({ latestCheckedRun });
    assert.equal(status.state, "unknown");
    assert.equal(status.label, "Not checked yet");
    assert.equal(status.checkedAt, null);
  }
});

test("a failed status query is distinct from a connection that was never checked", () => {
  const status = describeXForYouConnection({
    unavailable: true,
    latestHealthyRun: runWithCounts({
      x_for_you_auth_state: "healthy",
      x_for_you_checked_at: "2026-08-31T17:00:00.000Z",
      x_for_you_success_at: "2026-08-31T17:00:00.000Z",
    }),
  });

  assert.equal(status.state, "unknown");
  assert.equal(status.label, "Status unavailable");
  assert.equal(status.checkedAt, null);
  assert.equal(status.successAt, "2026-08-31T17:00:00.000Z");
});

test("the manual-login card gives the operator command explicitly", async () => {
  const source = await readFile(
    new URL(
      "../src/components/x-for-you-connection-status.jsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /npm run x:for-you:login/);
});
