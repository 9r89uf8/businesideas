import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const stubModules = {
  "server-only": dataModule("export default undefined;"),
  "workflow/api": dataModule("export async function start(...args){return globalThis.__cloudDispatchTest.start(...args);}"),
  "../../workflows/cloud-ideation.js": dataModule("export async function cloudIdeation(){}"),
  "../supabase/admin.js": dataModule("export function createSupabaseAdminClient(){return globalThis.__cloudDispatchTest.db;}"),
  "./service.js": dataModule(`
    export async function createCloudIdeationRun(...args){return globalThis.__cloudDispatchTest.create(...args);}
    export async function failCloudIdeationRun(...args){return globalThis.__cloudDispatchTest.fail(...args);}
  `),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(stubModules, specifier)) return { shortCircuit: true, url: stubModules[specifier] };
    return nextResolve(specifier, context);
  },
});
const { startCloudComparison } = await import("../src/lib/cloud-ideation/dispatch.js");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const ARGS = { runId: RUN_ID, ownerId: OWNER_ID, survivorPostIds: ["123456789"] };

function harness(options = {}) {
  const calls = [];
  const state = {
    id: RUN_ID, status: "pending", phase: "generating", workflow_run_id: null,
    ...options.comparison,
  };
  let created = false;
  let startAttempts = 0;
  const failures = [];

  class Query {
    constructor() { this.filters = []; }
    select() { this.operation = "read"; return this; }
    update(values) { this.operation = "save"; this.values = values; return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    is(column, value) { this.nullFilter = [column, value]; return this; }
    async execute() {
      assert.deepEqual(this.filters, [["id", RUN_ID], ["owner_id", OWNER_ID]]);
      calls.push(this.operation);
      if (this.operation === "read") {
        if (options.readThrows) throw options.readThrows;
        if (options.readError) return { data: null, error: options.readError };
        return { data: options.missingRead ? null : { ...state }, error: null };
      }
      assert.equal(this.operation, "save");
      assert.deepEqual(this.nullFilter, ["workflow_run_id", null]);
      if (options.saveThrows) throw options.saveThrows;
      if (options.saveError) return { error: options.saveError };
      if (state.workflow_run_id === null) Object.assign(state, this.values);
      return { error: null };
    }
    single() { return this.execute(); }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }

  globalThis.__cloudDispatchTest = {
    db: {
      async rpc(name, args) {
        assert.equal(name, "purge_cloud_model_payloads");
        assert.deepEqual(args, { p_owner_id: OWNER_ID });
        calls.push("purge");
        if (options.retentionThrows) throw options.retentionThrows;
        return { error: options.retentionError || null };
      },
      from(table) { assert.equal(table, "cloud_ideation_runs"); return new Query(); },
    },
    async create(args) {
      assert.deepEqual(args, { ...ARGS, mode: options.mode || "shadow" });
      calls.push("create");
      created = true;
      return { ...state };
    },
    async start(workflow, args) {
      assert.equal(typeof workflow, "function");
      assert.deepEqual(args, [{ runId: RUN_ID, ownerId: OWNER_ID }]);
      calls.push("start");
      startAttempts += 1;
      if (startAttempts <= (options.startFailures || 0)) throw new Error("Startup transport failed.");
      state.status = "running";
      return { runId: "workflow-1" };
    },
    async fail(args) {
      assert.equal(args.runId, RUN_ID);
      assert.equal(args.ownerId, OWNER_ID);
      calls.push("fail");
      failures.push(args);
      if (options.failThrows) throw options.failThrows;
      if (!["completed", "no_ideas", "failed"].includes(state.status)) state.status = "failed";
      return { ...state };
    },
  };
  return { calls, state, failures, get created() { return created; }, get startAttempts() { return startAttempts; } };
}

test("cloud startup retries twice and records only its acknowledged workflow", async () => {
  const fixture = harness({ startFailures: 2 });
  const result = await startCloudComparison(ARGS);
  assert.deepEqual(fixture.calls, ["purge", "create", "read", "start", "start", "start", "save"]);
  assert.equal(result.workflow_run_id, "workflow-1");
  assert.equal(result.dispatch_recorded, true);
  assert.equal(fixture.state.status, "running");
  assert.equal(fixture.failures.length, 0);
});

test("primary dispatch preserves the explicit mode at creation", async () => {
  const fixture = harness({ mode: "primary" });
  const result = await startCloudComparison({ ...ARGS, mode: "primary" });
  assert.equal(result.workflow_run_id, "workflow-1");
  assert.equal(fixture.startAttempts, 1);
});

test("three failed startup attempts close the comparison and preserve the startup error", async () => {
  const fixture = harness({ startFailures: 3, failThrows: new Error("Cleanup is unavailable.") });
  await assert.rejects(startCloudComparison(ARGS), /The cloud coordinator could not be started/);
  assert.equal(fixture.startAttempts, 3);
  assert.equal(fixture.failures.length, 1);
  assert.equal(fixture.calls.includes("save"), false);
});

test("exhausted startup attempts mark an undispatched comparison failed", async () => {
  const fixture = harness({ startFailures: 3 });
  await assert.rejects(startCloudComparison(ARGS), /could not be started/);
  assert.equal(fixture.state.status, "failed");
  assert.equal(fixture.state.workflow_run_id, null);
});

for (const failure of ["retentionError", "retentionThrows"]) {
  test(`${failure} cannot create an orphan comparison`, async () => {
    const fixture = harness({ [failure]: new Error("Retention unavailable.") });
    await assert.rejects(startCloudComparison(ARGS));
    assert.equal(fixture.created, false);
    assert.deepEqual(fixture.calls, ["purge"]);
  });
}

for (const failure of ["readError", "readThrows", "missingRead"]) {
  test(`${failure} closes the newly created comparison before rejecting`, async () => {
    const fixture = harness({ [failure]: failure === "missingRead" ? true : new Error("State read unavailable.") });
    await assert.rejects(startCloudComparison(ARGS));
    assert.equal(fixture.created, true);
    assert.equal(fixture.state.status, "failed");
    assert.equal(fixture.startAttempts, 0);
    assert.deepEqual(fixture.calls, ["purge", "create", "read", "fail"]);
  });
}

test("state-read cleanup failures do not mask the original transport error", async () => {
  const original = new Error("Original state-read transport error.");
  const fixture = harness({ readThrows: original, failThrows: new Error("Cleanup also failed.") });
  await assert.rejects(startCloudComparison(ARGS), (error) => error === original);
  assert.equal(fixture.failures.length, 1);
});

test("repeated dispatch of an existing workflow is idempotent", async () => {
  const fixture = harness();
  await startCloudComparison(ARGS);
  const repeated = await startCloudComparison(ARGS);
  assert.equal(fixture.startAttempts, 1);
  assert.equal(repeated.workflow_run_id, "workflow-1");
  assert.equal(repeated.status, "running");
  assert.equal(fixture.failures.length, 0);
});

for (const status of ["completed", "no_ideas", "failed"]) {
  test(`an existing ${status} comparison never starts another workflow`, async () => {
    const fixture = harness({ comparison: { status, phase: "done" } });
    const result = await startCloudComparison(ARGS);
    assert.equal(result.status, status);
    assert.equal(fixture.startAttempts, 0);
    assert.equal(fixture.failures.length, 0);
    assert.deepEqual(fixture.calls, ["purge", "create", "read"]);
  });
}

for (const failure of ["saveError", "saveThrows"]) {
  test(`an acknowledged workflow stays running after ${failure}`, async () => {
    const fixture = harness({ [failure]: new Error("Diagnostic save unavailable.") });
    const result = await startCloudComparison(ARGS);
    assert.equal(result.workflow_run_id, "workflow-1");
    assert.equal(result.dispatch_recorded, false);
    assert.equal(fixture.state.status, "running");
    assert.equal(fixture.state.workflow_run_id, null);
    assert.equal(fixture.startAttempts, 1);
    assert.equal(fixture.failures.length, 0);
  });
}
