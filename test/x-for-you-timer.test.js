import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Match the existing workflow tests, but scope stubs to this import so the
// full suite can also run without process isolation.
const workflowUrl = new URL("../src/workflows/daily-research.js?for-you-timer-test", import.meta.url).href;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const stub = (names) => moduleUrl(names.map((name) =>
  `export async function ${name}(...args) { return globalThis.__forYouTimerTest.${name}(...args); }`,
).join("\n"));
const modules = {
  "daily-research-steps.js": stub(["fetchAndRank", "readIdeationProvider", "recordWorkflowFailure", "recordXForYouConnectionStatus"]),
  "ideation-steps.js": stub(["filterCommercialPosts", "generateCandidateForPost", "hydrateNeededPostContext", "prepareCandidateResearchJob", "shortlistCommercialPosts"]),
  "openai-research-steps.js": stub(["cancelOpenAIResearchResponse", "claimPreparedResearchJob", "deleteOpenAIResearchResponse", "loadPreparedResearchJob", "persistOpenAIResearchResult", "pollOpenAIResearchResponse", "reportOpenAIResearchFailure", "startOpenAIResearchResponse"]),
  "research-finalizer-steps.js": stub(["finalizeResearchResult", "recordResearchFinalizerFailure"]),
  "x-for-you-cloud-steps.js": stub(["inspectXForYouCloudCommand", "inspectXForYouCloudReadiness", "parseXForYouCloudResult", "readXForYouCloudActivation", "sendXForYouCloudCollection", "startXForYouCloudInstance", "stopXForYouCloudInstance"]),
  "cloud-ideation-steps.js": stub(["launchCloudComparison", "stopCloudComparison"]),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL !== workflowUrl) return nextResolve(specifier, context);
    if (specifier === "workflow") return {
      shortCircuit: true,
      url: moduleUrl("export function sleep(...args){return globalThis.__forYouTimerTest.sleep(...args)}; export function createWebhook(){return globalThis.__forYouTimerTest.createWebhook()}"),
    };
    const replacement = modules[specifier.split("/").at(-1)];
    return replacement ? { shortCircuit: true, url: replacement } : nextResolve(specifier, context);
  },
});
const { dailyResearch } = await import(workflowUrl);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, message) {
  for (let turn = 0; turn < 100 && !predicate(); turn += 1) await Promise.resolve();
  assert.ok(predicate(), message);
}

function harness({ inspect = async () => ({ status: "running" }), parseFails = false, shutdownFails = false, disposeFails = false, sendStatus = "sent" } = {}) {
  const callback = deferred();
  const state = { sleeps: [], activeSleeps: 0, activeInspections: 0, inspections: 0, parsed: 0, shutdowns: 0, disposed: 0, fetched: null };
  globalThis.__forYouTimerTest = new Proxy({
    sleep(duration) {
      const timer = deferred();
      state.sleeps.push({ duration, ...timer });
      state.activeSleeps += 1;
      return timer.promise.finally(() => { state.activeSleeps -= 1; });
    },
    createWebhook() {
      return Object.assign(callback.promise, {
        url: "https://example.test/callback",
        dispose() { state.disposed += 1; if (disposeFails) throw new Error("Hook cleanup failed"); },
      });
    },
    readXForYouCloudActivation: async () => ({ status: "enabled", region: "us-east-1", instanceId: "instance-1" }),
    startXForYouCloudInstance: async () => ({ status: "running" }),
    inspectXForYouCloudReadiness: async () => ({ status: "ready" }),
    sendXForYouCloudCollection: async () => ({ status: sendStatus, commandId: "command-1" }),
    async inspectXForYouCloudCommand() {
      state.inspections += 1;
      state.activeInspections += 1;
      try { return await inspect(); } finally { state.activeInspections -= 1; }
    },
    parseXForYouCloudResult: async () => {
      state.parsed += 1;
      if (parseFails) throw new Error("Invalid callback");
      return { status: "completed", candidates: [{ postId: "123", feedPosition: 1 }] };
    },
    stopXForYouCloudInstance: async (target) => {
      assert.deepEqual(target, { region: "us-east-1", instanceId: "instance-1" });
      assert.equal(state.activeSleeps, 0, "A timer survived into instance shutdown");
      assert.equal(state.activeInspections, 0, "A status check survived into instance shutdown");
      state.shutdowns += 1;
      if (shutdownFails) throw new Error("Instance shutdown failed");
    },
    recordXForYouConnectionStatus: async () => {},
    fetchAndRank: async (args) => { state.fetched = args; return []; },
  }, {
    get(target, name) {
      return target[name] || (() => assert.fail(`Unexpected workflow step ${String(name)}`));
    },
  });
  const result = dailyResearch({ runId: "run-1", ownerId: "owner-1" });
  return { state, callback, result };
}

async function expectFinished(run, completed) {
  assert.deepEqual(await run.result, { status: "no_ideas" });
  assert.equal(run.state.fetched.forYouCollectionCompleted, completed);
  assert.deepEqual(run.state.fetched.forYouCandidates, completed ? [{ post_id: "123", feed_position: 1 }] : []);
  assert.equal(run.state.activeSleeps, 0);
  assert.equal(run.state.activeInspections, 0);
  assert.equal(run.state.shutdowns, 1);
  assert.equal(run.state.disposed, 1);
}

test("callback during watchdog sleep drains that timer without starting a status check", async () => {
  const run = harness();
  await until(() => run.state.sleeps.length === 1, "The watchdog did not begin sleeping");
  run.callback.resolve({});
  await until(() => run.state.parsed === 1, "The callback was not parsed promptly");
  assert.equal(run.state.fetched, null);
  assert.equal(run.state.shutdowns, 0);
  run.state.sleeps[0].resolve();
  await expectFinished(run, true);
  assert.equal(run.state.inspections, 0);
  assert.equal(run.state.sleeps.length, 1);
});

test("an already delivered callback wins without starting a watchdog timer", async () => {
  const run = harness();
  run.callback.resolve({});
  await expectFinished(run, true);
  assert.equal(run.state.sleeps.length, 0);
  assert.equal(run.state.inspections, 0);
});

for (const inspectionFails of [false, true]) {
  test(`callback during an in-flight status check drains it${inspectionFails ? " even when it fails" : ""}`, async () => {
    const inspection = deferred();
    const run = harness({ inspect: () => inspection.promise });
    await until(() => run.state.sleeps.length === 1, "No watchdog timer");
    run.state.sleeps[0].resolve();
    await until(() => run.state.inspections === 1, "The status check did not start");
    run.callback.resolve({});
    await until(() => run.state.parsed === 1, "The callback did not win");
    assert.equal(run.state.fetched, null);
    if (inspectionFails) inspection.reject(new Error("SSM unavailable"));
    else inspection.resolve({ status: "failed" });
    await expectFinished(run, true);
    assert.equal(run.state.inspections, 1);
    assert.equal(run.state.sleeps.length, 1, "No grace timer should start after the callback");
  });
}

for (const status of ["failed", "succeeded"]) {
  test(`${status} command preserves its callback grace period`, async () => {
    const run = harness({ inspect: async () => ({ status }) });
    await until(() => run.state.sleeps.length === 1, "No watchdog timer");
    run.state.sleeps[0].resolve();
    await until(() => run.state.sleeps.length === 2, "No terminal-command grace period");
    assert.equal(run.state.sleeps[1].duration, "30s");
    assert.equal(run.state.fetched, null);
    run.callback.resolve({});
    await until(() => run.state.parsed === 1, "A grace-period callback was discarded");
    run.state.sleeps[1].resolve();
    await expectFinished(run, true);
    assert.equal(run.state.inspections, 1);
  });

  test(`${status} command without a callback falls back only after grace`, async () => {
    const run = harness({ inspect: async () => ({ status }) });
    await until(() => run.state.sleeps.length === 1, "No watchdog timer");
    run.state.sleeps[0].resolve();
    await until(() => run.state.sleeps.length === 2, "No terminal-command grace period");
    assert.equal(run.state.fetched, null);
    run.state.sleeps[1].resolve();
    await expectFinished(run, false);
    assert.equal(run.state.parsed, 0);
  });
}

test("command timeout drains all bounded polls and the final callback grace period", async () => {
  const run = harness();
  for (let index = 0; index < 119; index += 1) {
    await until(() => run.state.sleeps.length === index + 1, "Missing bounded poll timer");
    assert.equal(run.state.sleeps[index].duration, "10s");
    run.state.sleeps[index].resolve();
  }
  await until(() => run.state.sleeps.length === 120, "Missing final callback grace period");
  assert.equal(run.state.sleeps[119].duration, "30s");
  run.state.sleeps[119].resolve();
  await expectFinished(run, false);
  assert.equal(run.state.inspections, 119);
});

test("callback during the final rejected status check starts no grace timer", async () => {
  const finalInspection = deferred();
  let inspections = 0;
  const run = harness({
    inspect: async () => ++inspections === 119 ? finalInspection.promise : { status: "running" },
  });
  for (let index = 0; index < 119; index += 1) {
    await until(() => run.state.sleeps.length === index + 1, "Missing bounded poll timer");
    run.state.sleeps[index].resolve();
  }
  await until(() => run.state.inspections === 119, "The final status check did not start");
  run.callback.resolve({});
  await until(() => run.state.parsed === 1, "The callback did not win during the final status check");
  finalInspection.reject(new Error("Final SSM check failed"));
  await until(() => run.state.fetched !== null || run.state.sleeps.length > 119, "Collection did not drain");
  assert.equal(run.state.sleeps.length, 119, "A new grace timer started after callback acceptance");
  await expectFinished(run, true);
});

test("callback parsing failure still drains the watchdog and shuts down collection", async () => {
  const run = harness({ parseFails: true });
  await until(() => run.state.sleeps.length === 1, "No watchdog timer");
  run.callback.resolve({});
  await until(() => run.state.parsed === 1, "The callback was not parsed");
  run.state.sleeps[0].resolve();
  await expectFinished(run, false);
  assert.equal(run.state.inspections, 0);
});

test("watchdog, shutdown and hook-cleanup failures cannot discard a valid callback", async () => {
  const run = harness({ shutdownFails: true, disposeFails: true });
  await until(() => run.state.sleeps.length === 1, "No watchdog timer");
  run.callback.resolve({});
  await until(() => run.state.parsed === 1, "The callback was not parsed");
  run.state.sleeps[0].reject(new Error("Timer transport failed during cleanup"));
  await expectFinished(run, true);
});

test("early collection failure shuts down without creating a watchdog", async () => {
  const run = harness({ sendStatus: "failed" });
  await expectFinished(run, false);
  assert.equal(run.state.sleeps.length, 0);
  assert.equal(run.state.inspections, 0);
});
