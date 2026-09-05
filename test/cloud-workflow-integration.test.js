import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const stub = (names) => moduleUrl(names.map((name) =>
  `export async function ${name}(...args) { return globalThis.__cloudWorkflowTest.${name}(...args); }`,
).join("\n"));
const modules = {
  "daily-research-steps.js": stub(["fetchAndRank", "readIdeationProvider", "recordWorkflowFailure", "recordXForYouConnectionStatus"]),
  "ideation-steps.js": stub(["filterCommercialPosts", "generateCandidateForPost", "hydrateNeededPostContext", "prepareCandidateResearchJob", "shortlistCommercialPosts"]),
  "openai-research-steps.js": stub(["cancelOpenAIResearchResponse", "claimPreparedResearchJob", "deleteOpenAIResearchResponse", "loadPreparedResearchJob", "persistOpenAIResearchResult", "pollOpenAIResearchResponse", "reportOpenAIResearchFailure", "startOpenAIResearchResponse"]),
  "research-finalizer-steps.js": stub(["finalizeResearchResult", "recordResearchFinalizerFailure"]),
  "x-for-you-cloud-steps.js": stub(["inspectXForYouCloudCommand", "inspectXForYouCloudReadiness", "parseXForYouCloudResult", "readXForYouCloudActivation", "sendXForYouCloudCollection", "startXForYouCloudInstance", "stopXForYouCloudInstance"]),
  "cloud-ideation-steps.js": stub(["launchCloudComparison", "advanceCloudComparison", "stopCloudComparison"]),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "workflow") return {
      shortCircuit: true,
      url: moduleUrl("export async function sleep(){}; export function createWebhook(){throw new Error('Unexpected webhook');}"),
    };
    const basename = specifier.split("/").at(-1);
    if (modules[basename]) return { shortCircuit: true, url: modules[basename] };
    return nextResolve(specifier, context);
  },
});
const { dailyResearch } = await import("../src/workflows/daily-research.js");
const { cloudIdeation } = await import("../src/workflows/cloud-ideation.js");

test("cloud dispatch failure leaves the full API generation, research and publication path working", async () => {
  const calls = [];
  globalThis.__cloudWorkflowTest = new Proxy({
    readIdeationProvider: async () => "api",
    readXForYouCloudActivation: async () => ({ status: "disabled" }),
    fetchAndRank: async () => ["post-1"],
    filterCommercialPosts: async () => ({ survivorPostIds: ["post-1"], needsContextPostIds: [] }),
    hydrateNeededPostContext: async () => ["post-1"],
    launchCloudComparison: async () => { calls.push("cloud-dispatch"); throw new Error("Cloud unavailable"); },
    stopCloudComparison: async () => { calls.push("cloud-failure-recorded"); },
    shortlistCommercialPosts: async () => { calls.push("api-shortlist"); return [{ postId: "post-1", clusterId: "cluster-1" }]; },
    generateCandidateForPost: async () => { calls.push("api-generation"); },
    prepareCandidateResearchJob: async () => "job-1",
    loadPreparedResearchJob: async () => ({ status: "pending", availableAt: "2026-01-01T00:00:00Z" }),
    claimPreparedResearchJob: async () => ({ jobId: "job-1" }),
    startOpenAIResearchResponse: async () => { calls.push("api-research"); return { status: "completed", result: {}, usage: {} }; },
    persistOpenAIResearchResult: async () => { calls.push("api-save"); },
    finalizeResearchResult: async () => { calls.push("api-publish"); return ["idea-1"]; },
  }, {
    get(target, property) {
      return target[property] || (() => { throw new Error(`Unexpected step ${String(property)}`); });
    },
  });
  const result = await dailyResearch({ runId: "run-1", ownerId: "owner-1" });
  assert.deepEqual(calls, ["cloud-dispatch", "cloud-failure-recorded", "api-shortlist", "api-generation", "api-research", "api-save", "api-publish"]);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.ideaIds, ["idea-1"]);
});

for (const dispatchFails of [false, true]) {
  test(`primary cloud routing never calls Sol API stages${dispatchFails ? " when dispatch fails" : ""}`, async () => {
    const calls = [];
    globalThis.__cloudWorkflowTest = new Proxy({
      readXForYouCloudActivation: async () => ({ status: "disabled" }),
      fetchAndRank: async () => ["post-1"],
      filterCommercialPosts: async () => ({ survivorPostIds: ["post-1"], needsContextPostIds: [] }),
      hydrateNeededPostContext: async () => ["post-1"],
      readIdeationProvider: async () => "chatgpt_cloud",
      launchCloudComparison: async (args) => {
        assert.equal(args.mode, "primary");
        calls.push("cloud-dispatch");
        if (dispatchFails) throw new Error("Unavailable");
        return { status: "running" };
      },
      stopCloudComparison: async () => calls.push("cloud-stopped"),
      recordWorkflowFailure: async () => calls.push("run-failed"),
    }, {
      get(target, property) {
        return target[property] || (() => assert.fail(`Unexpected API step ${String(property)}`));
      },
    });
    if (dispatchFails) {
      await assert.rejects(dailyResearch({ runId: "run-1", ownerId: "owner-1" }), /API fallback is disabled/);
      assert.deepEqual(calls, ["cloud-dispatch", "cloud-stopped", "run-failed"]);
    } else {
      assert.deepEqual(await dailyResearch({ runId: "run-1", ownerId: "owner-1" }), {
        status: "running", provider: "chatgpt_cloud", cloudRunId: "run-1",
      });
      assert.deepEqual(calls, ["cloud-dispatch"]);
    }
  });
}

test("cloud coordinator waits for asynchronous submissions and returns its terminal comparison", async () => {
  const states = [{ status: "running", phase: "generating" }, { status: "running", phase: "researching" }, { status: "completed", phase: "done" }];
  globalThis.__cloudWorkflowTest = {
    advanceCloudComparison: async () => states.shift(),
    stopCloudComparison: async () => assert.fail("Successful comparison must not be failed"),
  };
  assert.deepEqual(await cloudIdeation({ runId: "run-1", ownerId: "owner-1" }), { status: "completed", phase: "done" });
  assert.equal(states.length, 0);
});

test("coordinator failure is contained in the cloud comparison", async () => {
  let stopped;
  globalThis.__cloudWorkflowTest = {
    advanceCloudComparison: async () => { throw new Error("Invalid cloud result"); },
    stopCloudComparison: async (args) => { stopped = args; },
  };
  assert.deepEqual(await cloudIdeation({ runId: "run-1", ownerId: "owner-1" }), { status: "failed", runId: "run-1" });
  assert.equal(stopped.runId, "run-1");
  assert.equal(stopped.ownerId, "owner-1");
});
