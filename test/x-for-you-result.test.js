import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20default%20undefined",
      };
    }
    return nextResolve(specifier, context);
  },
});

const {
  ForYouResultError,
  MAX_FOR_YOU_RESULT_BYTES,
  parseForYouResultRequest,
  parseForYouResultText,
  validateForYouResult,
} = await import("../src/lib/x/for-you-result.js");

const FIRST_POST_ID = "1900000000000000001";
const SECOND_POST_ID = "1900000000000000002";

function validPayload(overrides = {}) {
  return {
    collectorRunId: "collector-run_2026.08.30",
    candidates: [
      { postId: SECOND_POST_ID, feedPosition: 2 },
      { postId: FIRST_POST_ID, feedPosition: 1 },
    ],
    ...overrides,
  };
}

function validFailurePayload(overrides = {}) {
  return {
    status: "failed",
    errorCode: "MANUAL_ACTION_REQUIRED",
    candidates: [],
    ...overrides,
  };
}

function assertGenericFailure(operation) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof ForYouResultError);
    assert.equal(error.code, "INVALID_FOR_YOU_RESULT");
    assert.equal(error.message, "Invalid For You collector result.");
    return true;
  });
}

test("For You result validation returns a bounded feed-ordered value", () => {
  const result = validateForYouResult(validPayload());

  assert.deepEqual(result, {
    status: "completed",
    collectorRunId: "collector-run_2026.08.30",
    candidates: [
      { postId: FIRST_POST_ID, feedPosition: 1 },
      { postId: SECOND_POST_ID, feedPosition: 2 },
    ],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  assert.deepEqual(
    validateForYouResult(validPayload({ candidates: [] })).candidates,
    [],
  );
  assert.equal(
    validateForYouResult(
      validPayload({
        candidates: Array.from({ length: 100 }, (_, index) => ({
          postId: String(index + 1),
          feedPosition: index + 1,
        })),
      }),
    ).candidates.length,
    100,
  );
});

test("For You result validation accepts only safe terminal failures", () => {
  for (const errorCode of [
    "AUTH_FAILED",
    "MANUAL_ACTION_REQUIRED",
    "NAVIGATION_BLOCKED",
    "SESSION_EXPIRED",
  ]) {
    const result = validateForYouResult(validFailurePayload({ errorCode }));
    assert.deepEqual(result, {
      status: "failed",
      errorCode,
      candidates: [],
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.candidates), true);
  }
});

test("For You result validation rejects unknown and credential-bearing fields", () => {
  for (const payload of [
    { ...validPayload(), password: "not-accepted" },
    {
      ...validPayload(),
      candidates: [
        { postId: FIRST_POST_ID, feedPosition: 1, cookie: "not-accepted" },
      ],
    },
    {
      ...validPayload(),
      candidates: [
        { postId: FIRST_POST_ID, feedPosition: 1 },
        { postId: FIRST_POST_ID, feedPosition: 2 },
      ],
    },
    {
      ...validPayload(),
      candidates: [
        { postId: FIRST_POST_ID, feedPosition: 1 },
        { postId: SECOND_POST_ID, feedPosition: 1 },
      ],
    },
    validPayload({
      candidates: [{ postId: "01", feedPosition: 1 }],
    }),
    validPayload({
      candidates: [{ postId: FIRST_POST_ID, feedPosition: 0 }],
    }),
    validPayload({ collectorRunId: "unsafe/run" }),
    validPayload({ collectorRunId: "x".repeat(65) }),
    validFailurePayload({ errorCode: "secret-value" }),
    validFailurePayload({ candidates: [{ postId: FIRST_POST_ID, feedPosition: 1 }] }),
    { ...validFailurePayload(), message: "not-accepted" },
    { ...validFailurePayload(), collectorRunId: "not-accepted" },
    validPayload({
      candidates: Array.from({ length: 101 }, (_, index) => ({
        postId: String(index + 1),
        feedPosition: index + 1,
      })),
    }),
  ]) {
    assertGenericFailure(() => validateForYouResult(payload));
  }
});

test("For You result text parsing bounds bytes and never exposes input", () => {
  const text = JSON.stringify(validPayload());
  assert.deepEqual(parseForYouResultText(text), validateForYouResult(validPayload()));
  assert.deepEqual(
    parseForYouResultText(JSON.stringify(validFailurePayload())),
    validateForYouResult(validFailurePayload()),
  );

  for (const invalidText of [
    "",
    "{invalid-json",
    JSON.stringify({ ...validPayload(), token: "top-secret-token" }),
    `"${"x".repeat(MAX_FOR_YOU_RESULT_BYTES)}"`,
  ]) {
    assertGenericFailure(() => parseForYouResultText(invalidText));
  }
});

test("For You result request parsing enforces JSON and actual byte length", async () => {
  const text = JSON.stringify(validPayload());
  const validRequest = new Request("https://workflow.invalid/callback", {
    method: "POST",
    headers: {
      "content-length": String(Buffer.byteLength(text)),
      "content-type": "application/json; charset=utf-8",
    },
    body: text,
  });
  assert.deepEqual(
    await parseForYouResultRequest(validRequest),
    validateForYouResult(validPayload()),
  );

  const invalidRequests = [
    new Request("https://workflow.invalid/callback", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: text,
    }),
    new Request("https://workflow.invalid/callback", {
      method: "POST",
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      body: text,
    }),
    new Request("https://workflow.invalid/callback", {
      method: "POST",
      headers: {
        "content-length": String(Buffer.byteLength(text) + 1),
        "content-type": "application/json",
      },
      body: text,
    }),
    new Request("https://workflow.invalid/callback", {
      method: "POST",
      headers: {
        "content-length": String(MAX_FOR_YOU_RESULT_BYTES + 1),
        "content-type": "application/json",
      },
      body: text,
    }),
    new Request("https://workflow.invalid/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(MAX_FOR_YOU_RESULT_BYTES + 1),
    }),
  ];

  for (const request of invalidRequests) {
    await assert.rejects(
      parseForYouResultRequest(request),
      (error) =>
        error instanceof ForYouResultError &&
        error.message === "Invalid For You collector result.",
    );
  }
});
