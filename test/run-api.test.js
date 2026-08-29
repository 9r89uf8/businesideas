import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

const emptyModule = "data:text/javascript,export%20default%20undefined";
const dataModule = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const adminStub = dataModule(
  "export function createSupabaseAdminClient(){return globalThis.__runApiAdmin}",
);
const authStub = dataModule(
  "export async function requireOwnerForApi(){return globalThis.__runApiIdentity ?? null}",
);
const workflowApiStub = dataModule(
  "export async function start(...args){return globalThis.__runApiDispatch?.(...args)}",
);
const dailyWorkflowStub =
  "data:text/javascript,export%20async%20function%20dailyResearch()%7B%7D";
const sourceRoot = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: emptyModule };
    }
    if (specifier === "@/lib/supabase/admin") {
      return { shortCircuit: true, url: adminStub };
    }
    if (specifier === "@/lib/auth") {
      return { shortCircuit: true, url: authStub };
    }
    if (specifier === "@/workflows/daily-research") {
      return { shortCircuit: true, url: dailyWorkflowStub };
    }
    if (specifier === "workflow/api") {
      return { shortCircuit: true, url: workflowApiStub };
    }
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: new URL(`${specifier.slice(2)}.js`, sourceRoot).href,
      };
    }

    return nextResolve(specifier, context);
  },
});

const {
  ActiveRunError,
  RUN_START_OUTCOMES,
  buildEffectiveSettings,
  createRunKey,
  isStaleRun,
  startRun,
} = await import("../src/lib/runs/start-run.js");
const { mergeRunJson } = await import("../src/lib/runs/finish-run.js");
const { validateFeedbackPayload } = await import(
  "../src/app/api/ideas/[id]/feedback/route.js"
);

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

function createScriptedAdmin(responses) {
  const remaining = [...responses];
  const calls = [];

  function consume(query, terminal) {
    query.operations.push({ method: terminal, args: [] });
    assert.ok(
      remaining.length,
      `Unexpected ${terminal} query on ${query.table}.`,
    );
    const response = remaining.shift();
    return typeof response === "function" ? response(query) : response;
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.operations = [];
      calls.push(this);
    }

    operation(method, ...args) {
      this.operations.push({ method, args });
      return this;
    }

    select(...args) {
      return this.operation("select", ...args);
    }

    insert(...args) {
      return this.operation("insert", ...args);
    }

    update(...args) {
      return this.operation("update", ...args);
    }

    eq(...args) {
      return this.operation("eq", ...args);
    }

    in(...args) {
      return this.operation("in", ...args);
    }

    order(...args) {
      return this.operation("order", ...args);
    }

    limit(...args) {
      return this.operation("limit", ...args);
    }

    single() {
      return Promise.resolve(consume(this, "single"));
    }

    maybeSingle() {
      return Promise.resolve(consume(this, "maybeSingle"));
    }

    then(onFulfilled, onRejected) {
      return Promise.resolve(consume(this, "await")).then(
        onFulfilled,
        onRejected,
      );
    }
  }

  return {
    calls,
    from(table) {
      return new Query(table);
    },
    assertExhausted() {
      assert.equal(remaining.length, 0, "Not all scripted queries were used.");
    },
  };
}

function baseStartResponses(insertResponse, activeRuns = []) {
  return [
    { data: activeRuns, error: null },
    { data: null, error: null },
    insertResponse,
  ];
}

function runRecord(overrides = {}) {
  return {
    id: RUN_ID,
    status: "queued",
    stage: null,
    counts: {},
    error_message: null,
    window_start: "2026-08-26T13:00:00.000Z",
    window_end: "2026-08-27T13:00:00.000Z",
    ...overrides,
  };
}

test("buildEffectiveSettings applies safe defaults and operating caps", () => {
  const defaults = buildEffectiveSettings(null);
  assert.equal(defaults.candidate_limit, 200);
  assert.equal(defaults.ai_input_limit, 100);
  assert.equal(defaults.ranking_version, "views_v3");
  assert.equal(defaults.minimum_views, 50_000);
  assert.equal(defaults.research_window_hours, 72);
  assert.match(defaults.x_query, /lang:en -is:retweet/);
  assert.deepEqual(defaults.followed_x_usernames, []);
  assert.ok(defaults.preferences.preferred_customers.length > 0);

  const customized = buildEffectiveSettings({
    x_query: "  AI workaround lang:en  ",
    candidate_limit: 500,
    ai_input_limit: 175,
    followed_x_usernames: [
      " @OpenAI ",
      "openai",
      "AnthropicAI",
      "bad handle OR AI",
    ],
    preferences: {
      offer_bias: "  software_first ",
      preferred_customers: [],
      preferred_business_models: [" small SaaS ", null],
      avoid: "invalid",
      personal_advantages: [" automation "],
    },
  });

  assert.equal(customized.x_query, "AI workaround lang:en");
  assert.equal(customized.candidate_limit, 200);
  assert.equal(customized.ai_input_limit, 100);
  assert.deepEqual(customized.followed_x_usernames, [
    "openai",
    "anthropicai",
  ]);
  assert.equal(customized.preferences.offer_bias, "software_first");
  assert.deepEqual(customized.preferences.preferred_customers, []);
  assert.deepEqual(customized.preferences.preferred_business_models, [
    "small SaaS",
  ]);
  assert.ok(customized.preferences.avoid.length > 0);
  assert.deepEqual(customized.preferences.personal_advantages, ["automation"]);
});

test("createRunKey is stable per UTC day and unique for manual runs", () => {
  assert.equal(
    createRunKey("scheduled", new Date("2026-08-27T23:59:59Z")),
    "scheduled:2026-08-27",
  );

  const first = createRunKey("manual");
  const second = createRunKey("manual");
  assert.match(first, /^manual:[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
  assert.throws(() => createRunKey("other"), /scheduled or manual/);
});

test("isStaleRun uses queued time and the actual running start time", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");

  assert.equal(
    isStaleRun(
      {
        status: "queued",
        created_at: "2026-08-27T05:00:00Z",
        started_at: null,
      },
      now,
    ),
    true,
  );
  assert.equal(
    isStaleRun(
      {
        status: "running",
        created_at: "2026-08-27T04:00:00Z",
        started_at: "2026-08-27T11:00:00Z",
      },
      now,
    ),
    false,
  );
  assert.equal(
    isStaleRun(
      {
        status: "running",
        created_at: "2026-08-27T04:00:00Z",
        started_at: "2026-08-27T05:00:00Z",
      },
      now,
    ),
    true,
  );
  assert.equal(
    isStaleRun(
      { status: "completed", created_at: "2026-08-20T00:00:00Z" },
      now,
    ),
    false,
  );
});

test("startRun reports a newly dispatched manual run explicitly", async () => {
  const admin = createScriptedAdmin(
    baseStartResponses({ data: runRecord(), error: null }),
  );
  const dispatches = [];
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async (...args) => {
    dispatches.push(args);
  };

  const run = await startRun({ ownerId: OWNER_ID, trigger: "manual" });

  assert.equal(run.id, RUN_ID);
  assert.equal(run.outcome, RUN_START_OUTCOMES.STARTED);
  assert.equal(dispatches.length, 1);
  assert.deepEqual(dispatches[0][1], [
    { runId: RUN_ID, ownerId: OWNER_ID },
  ]);
  const insertOperation = admin.calls
    .flatMap((query) => query.operations)
    .find((operation) => operation.method === "insert");
  const insertedRun = insertOperation.args[0];
  assert.equal(
    Date.parse(insertedRun.window_end) - Date.parse(insertedRun.window_start),
    72 * 60 * 60 * 1_000,
  );
  assert.equal(insertedRun.settings_snapshot.minimum_views, 50_000);
  admin.assertExhausted();
});

test("same-day scheduled repeats reuse a finished report without dispatch", async () => {
  const finished = runRecord({ status: "completed", stage: null });
  const admin = createScriptedAdmin([
    ...baseStartResponses({ data: null, error: { code: "23505" } }),
    { data: null, error: null },
    { data: finished, error: null },
  ]);
  let dispatchCount = 0;
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async () => {
    dispatchCount += 1;
  };

  const run = await startRun({ ownerId: OWNER_ID, trigger: "scheduled" });

  assert.equal(run.id, RUN_ID);
  assert.equal(run.status, "completed");
  assert.equal(run.outcome, RUN_START_OUTCOMES.ALREADY_FINISHED);
  assert.equal(dispatchCount, 0);
  admin.assertExhausted();
});

test("a failed scheduled run is atomically requeued on its original ID", async () => {
  const failed = runRecord({
    status: "failed",
    stage: "extracting",
    counts: { sent_to_luna: 70 },
    error_message: "Signal extraction failed after retries.",
  });
  const retried = runRecord({
    status: "queued",
    stage: "extracting",
    counts: { sent_to_luna: 70 },
  });
  const admin = createScriptedAdmin([
    ...baseStartResponses({ data: null, error: { code: "23505" } }),
    { data: null, error: null },
    { data: failed, error: null },
    { data: retried, error: null },
  ]);
  const dispatches = [];
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async (...args) => {
    dispatches.push(args);
  };

  const run = await startRun({ ownerId: OWNER_ID, trigger: "scheduled" });

  assert.equal(run.id, RUN_ID);
  assert.equal(run.stage, "extracting");
  assert.deepEqual(run.counts, { sent_to_luna: 70 });
  assert.equal(run.outcome, RUN_START_OUTCOMES.RETRIED);
  assert.equal(dispatches.length, 1);

  const retryUpdate = admin.calls.find((query) =>
    query.operations.some(
      (operation) =>
        operation.method === "update" &&
        operation.args[0]?.status === "queued",
    ),
  );
  const retryValues = retryUpdate.operations.find(
    (operation) => operation.method === "update",
  ).args[0];
  assert.equal(retryValues.started_at, null);
  assert.equal(retryValues.completed_at, null);
  assert.equal(retryValues.error_message, null);
  assert.ok(Number.isFinite(Date.parse(retryValues.created_at)));
  assert.ok(
    retryUpdate.operations.some(
      (operation) =>
        operation.method === "eq" &&
        operation.args[0] === "status" &&
        operation.args[1] === "failed",
    ),
  );
  admin.assertExhausted();
});

test("stale scheduled runs are closed before the same row is retried", async () => {
  const staleRun = {
    id: RUN_ID,
    status: "running",
    created_at: "2020-01-01T00:00:00.000Z",
    started_at: "2020-01-01T00:00:01.000Z",
  };
  const failed = runRecord({ status: "failed", stage: "clustering" });
  const retried = runRecord({ status: "queued", stage: "clustering" });
  const admin = createScriptedAdmin([
    { data: [staleRun], error: null },
    { data: null, error: null },
    { data: null, error: null },
    { data: null, error: { code: "23505" } },
    { data: null, error: null },
    { data: failed, error: null },
    { data: retried, error: null },
  ]);
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async () => {};

  const run = await startRun({ ownerId: OWNER_ID, trigger: "scheduled" });

  assert.equal(run.id, RUN_ID);
  assert.equal(run.stage, "clustering");
  assert.equal(run.outcome, RUN_START_OUTCOMES.RETRIED);
  const updates = admin.calls
    .map((query) =>
      query.operations.find((operation) => operation.method === "update"),
    )
    .filter(Boolean)
    .map((operation) => operation.args[0]);
  assert.deepEqual(
    updates.map((values) => values.status),
    ["failed", "queued"],
  );
  admin.assertExhausted();
});

test("a genuine active-run conflict remains an ActiveRunError", async () => {
  const active = {
    id: "33333333-3333-4333-8333-333333333333",
    status: "running",
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
  };
  const admin = createScriptedAdmin([
    ...baseStartResponses(
      { data: null, error: { code: "23505" } },
      [active],
    ),
    { data: active, error: null },
    { data: null, error: null },
  ]);
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async () => {
    assert.fail("An overlapping workflow must not be dispatched.");
  };

  await assert.rejects(
    startRun({ ownerId: OWNER_ID, trigger: "scheduled" }),
    ActiveRunError,
  );
  admin.assertExhausted();
});

test("an unexplained unique violation is not mislabeled as an active run", async () => {
  const admin = createScriptedAdmin([
    ...baseStartResponses({ data: null, error: { code: "23505" } }),
    { data: null, error: null },
    { data: null, error: null },
  ]);
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async () => {};

  await assert.rejects(
    startRun({ ownerId: OWNER_ID, trigger: "scheduled" }),
    (error) => {
      assert.equal(error instanceof ActiveRunError, false);
      assert.match(error.message, /could not be resolved/i);
      return true;
    },
  );
  admin.assertExhausted();
});

test("dispatch failures only mark an active run as failed", async () => {
  const admin = createScriptedAdmin([
    ...baseStartResponses({ data: runRecord(), error: null }),
    { data: null, error: null },
  ]);
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async () => {
    throw new Error("queue unavailable");
  };

  await assert.rejects(
    startRun({ ownerId: OWNER_ID, trigger: "manual" }),
    /could not be started/i,
  );

  const failureUpdate = admin.calls.find((query) =>
    query.operations.some(
      (operation) =>
        operation.method === "update" &&
        operation.args[0]?.error_message ===
          "The research workflow could not be started.",
    ),
  );
  assert.ok(
    failureUpdate.operations.some(
      (operation) =>
        operation.method === "in" &&
        operation.args[0] === "status" &&
        operation.args[1].join(",") === "queued,running",
    ),
  );
  admin.assertExhausted();
});

test("the cron API returns an idempotent finished outcome with HTTP 200", async () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousOwnerId = process.env.OWNER_USER_ID;
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.OWNER_USER_ID = OWNER_ID;
  const finished = runRecord({ status: "no_ideas" });
  const admin = createScriptedAdmin([
    ...baseStartResponses({ data: null, error: { code: "23505" } }),
    { data: null, error: null },
    { data: finished, error: null },
  ]);
  globalThis.__runApiAdmin = admin;
  globalThis.__runApiDispatch = async () => {
    assert.fail("A finished scheduled run must not be dispatched again.");
  };

  try {
    const { GET } = await import("../src/app/api/cron/daily/route.js");
    const response = await GET(
      new Request("http://localhost/api/cron/daily", {
        headers: { authorization: "Bearer test-cron-secret" },
      }),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      id: RUN_ID,
      status: "no_ideas",
      outcome: RUN_START_OUTCOMES.ALREADY_FINISHED,
    });
    admin.assertExhausted();
  } finally {
    if (previousSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previousSecret;
    }
    if (previousOwnerId === undefined) {
      delete process.env.OWNER_USER_ID;
    } else {
      process.env.OWNER_USER_ID = previousOwnerId;
    }
  }
});

test("mergeRunJson preserves prior counters and nested usage", () => {
  assert.deepEqual(
    mergeRunJson(
      {
        x_returned: 100,
        luna: { input_tokens: 1_000, output_tokens: 200 },
      },
      {
        relevant_signals: 30,
        luna: { output_tokens: 250 },
      },
    ),
    {
      x_returned: 100,
      relevant_signals: 30,
      luna: { input_tokens: 1_000, output_tokens: 250 },
    },
  );
  assert.throws(() => mergeRunJson({}, []), /must be objects/);
});

test("validateFeedbackPayload enforces decision, reason, and note rules", () => {
  assert.deepEqual(
    validateFeedbackPayload({
      status: "saved",
      feedback_reason: " strong_fit ",
      feedback_note: " Worth testing. ",
    }),
    {
      data: {
        status: "saved",
        feedback_reason: "strong_fit",
        feedback_note: "Worth testing.",
      },
    },
  );
  assert.match(
    validateFeedbackPayload({ status: "rejected" }).error,
    /reason is required/i,
  );
  assert.match(
    validateFeedbackPayload({ status: "unknown" }).error,
    /invalid idea status/i,
  );
  assert.match(
    validateFeedbackPayload({
      status: "saved",
      feedback_note: "x".repeat(1_001),
    }).error,
    /1,000 characters or fewer/,
  );
});
