import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [workflow, steps, responseHelper, service, vercel] = await Promise.all([
  readFile(new URL("../src/workflows/daily-research.js", import.meta.url), "utf8"),
  readFile(
    new URL("../src/workflows/openai-research-steps.js", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/lib/openai/research-response.js", import.meta.url),
    "utf8",
  ),
  readFile(
    new URL("../src/lib/research/job-service.js", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../vercel.json", import.meta.url), "utf8"),
]);

test("daily workflow continues from the durable job into API research", () => {
  const prepare = workflow.indexOf("await prepareCandidateResearchJob");
  const claim = workflow.indexOf("await claimPreparedResearchJob", prepare);
  const create = workflow.indexOf("await startOpenAIResearchResponse", claim);
  const poll = workflow.indexOf("await pollOpenAIResearchResponse", create);
  const persist = workflow.indexOf("await persistOpenAIResearchResult", poll);
  const finalize = workflow.indexOf("return finishSubmittedResearch", persist);

  assert.ok(prepare >= 0);
  assert.ok(claim > prepare);
  assert.ok(create > claim);
  assert.ok(poll > create);
  assert.ok(persist > poll);
  assert.ok(finalize > persist);
  assert.doesNotMatch(workflow, /status: "research_queued"/);
  assert.match(workflow, /await sleep\(`/);
  assert.match(workflow, /responseDeadlineSeconds/);
  assert.match(
    workflow,
    /try \{\s*claim = await claimPreparedResearchJob[\s\S]*catch \{[\s\S]*await sleep\("5s"\)/,
  );
  const claimedState = workflow.indexOf('state.status === "claimed"');
  const leaseSleep = workflow.indexOf(
    "await sleep(new Date(state.leaseExpiresAt))",
    claimedState,
  );
  const claimAfterLease = workflow.indexOf(
    "claim = await claimPreparedResearchJob",
    leaseSleep,
  );
  assert.ok(claimedState >= 0 && leaseSleep > claimedState);
  assert.ok(claimAfterLease > leaseSleep);
  assert.doesNotMatch(
    workflow.slice(leaseSleep, claimAfterLease),
    /\bcontinue\b/,
  );
});

test("one database claim makes one non-retried paid POST attempt", () => {
  const createStart = steps.indexOf("responses.create(request");
  const createEnd = steps.indexOf("startOpenAIResearchResponse.maxRetries", createStart);
  const createBlock = steps.slice(createStart, createEnd);

  assert.match(
    createBlock,
    /"X-Client-Request-Id": `sf-research-\$\{claim\.jobId\}-\$\{claim\.attemptCount\}`/,
  );
  assert.match(createBlock, /maxRetries: 0/);
  assert.doesNotMatch(createBlock, /idempotencyKey|Idempotency-Key/);
  assert.match(steps, /startOpenAIResearchResponse\.maxRetries = 0/);
  assert.match(responseHelper, /background: true/);
  assert.match(steps, /parseResearchResponse\(response, \{ accessedAt \}\)/);
  assert.match(steps, /validateResearchResultShape\(parsed\.data\)/);
});

test("API submission persists without dispatching a competing finalizer", () => {
  const persistStart = service.indexOf("export async function persistResearchResult");
  const dispatchStart = service.indexOf(
    "export async function submitResearchResultAndDispatch",
  );
  const persistBlock = service.slice(persistStart, dispatchStart);

  assert.match(persistBlock, /\.rpc\("submit_research_result"/);
  assert.doesNotMatch(persistBlock, /dispatchResearchFinalizer/);
  assert.match(workflow, /finalizeResearchResult\(\{ jobId, ownerId \}\)/);
  assert.match(
    workflow,
    /await persistOpenAIResearchResult[\s\S]*await deleteOpenAIResearchResponse[\s\S]*return finishSubmittedResearch/,
  );
  assert.match(steps, /responses\.cancel[\s\S]*safeTerminalResponse/);
  assert.match(steps, /responses\.delete/);
});

test("deployment keeps one daily cron instead of adding a polling cron", () => {
  const config = JSON.parse(vercel);

  assert.deepEqual(config.crons, [
    { path: "/api/cron/daily", schedule: "0 13 * * *" },
  ]);
});
