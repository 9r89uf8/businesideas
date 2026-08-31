import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

const emptyModule = "data:text/javascript,export%20default%20undefined";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: emptyModule };
    }

    return nextResolve(specifier, context);
  },
});

const {
  buildLunaCheckpointPayload,
  buildTerraCheckpointPayload,
} = await import("../src/workflows/daily-research-steps.js");

const migration = readFileSync(
  new URL("../supabase/migrations/001_initial_schema.sql", import.meta.url),
  "utf8",
);
const additiveMigration = readFileSync(
  new URL(
    "../supabase/migrations/002_hybrid_sources_and_product_contract.sql",
    import.meta.url,
  ),
  "utf8",
);
const workflowSource = readFileSync(
  new URL("../src/workflows/daily-research-steps.js", import.meta.url),
  "utf8",
);
const finalizerSource = readFileSync(
  new URL("../src/workflows/research-finalizer-steps.js", import.meta.url),
  "utf8",
);
const researchMigration = readFileSync(
  new URL(
    "../supabase/migrations/003_scheduled_research_worker.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBlock(name, nextMarker, source = migration) {
  const start = source.lastIndexOf(
    `create or replace function public.${name}(`,
  );
  const end = source.indexOf(nextMarker, start);

  assert.notEqual(start, -1, `${name} must exist in the migration`);
  assert.notEqual(end, -1, `${name} must have a bounded migration block`);
  return source.slice(start, end);
}

test("checkpoint payloads contain only database-owned Luna and Terra fields", () => {
  assert.deepEqual(
    buildLunaCheckpointPayload([
      {
        post_id: "123",
        relevant: true,
        signal_type: "pain",
        target_customer: "accountants",
        problem: "manual review",
        evidence_excerpt: "",
        signal_summary: "Review is manual.",
        commercial_score: 82,
        hype_score: 0,
        opportunity_score: 0.71,
        text: "must not cross the RPC boundary",
        author_id: "author-1",
      },
    ]),
    [
      {
        post_id: "123",
        relevant: true,
        signal_type: "pain",
        target_customer: "accountants",
        problem: "manual review",
        evidence_excerpt: null,
        signal_summary: "Review is manual.",
        commercial_score: 82,
        hype_score: 0,
        opportunity_score: 0.71,
      },
    ],
  );

  assert.deepEqual(
    buildTerraCheckpointPayload([
      {
        id: "model-only-id",
        title: "AI review controls",
        target_customer: "accountants",
        problem: "manual review",
        why_now: "AI adoption",
        summary: "A repeated control gap.",
        evidence_post_ids: ["1", "2", "3"],
        evidence_strength: 80,
        payment_signal: 55,
        eligible: true,
        eligibility_reasons: [],
      },
    ]),
    [
      {
        title: "AI review controls",
        target_customer: "accountants",
        problem: "manual review",
        why_now: "AI adoption",
        summary: "A repeated control gap.",
        evidence_post_ids: ["1", "2", "3"],
        evidence_strength: 80,
        payment_signal: 55,
        eligible: true,
      },
    ],
  );
});

test("Luna checkpoint is locked, atomic, idempotent, and service-role only", () => {
  const block = functionBlock(
    "persist_luna_checkpoint",
    "create or replace function public.persist_terra_checkpoint(",
    researchMigration,
  );

  assert.match(block, /security invoker/i);
  assert.match(block, /for update/i);
  for (const stage of [
    "clustering",
    "generating",
    "research_queued",
    "researching",
    "validating",
    "saving",
  ]) {
    assert.match(block, new RegExp(`'${stage}'`));
  }
  assert.match(block, /update public\.run_posts/i);
  assert.match(block, /update public\.runs/i);
  assert.ok(
    block.indexOf("update public.run_posts") < block.indexOf("update public.runs"),
  );
  assert.match(block, /jsonb_build_object\('luna', p_luna_usage\)/i);
  assert.match(block, /from public, anon, authenticated/i);
  assert.match(block, /to service_role/i);
});

test("Terra checkpoint replaces clusters and advances the run in one lock", () => {
  const block = functionBlock(
    "persist_terra_checkpoint",
    "commit;",
    researchMigration,
  );
  const deleteIndex = block.indexOf("delete from public.clusters");
  const insertIndex = block.indexOf("insert into public.clusters");
  const runUpdateIndex = block.indexOf("update public.runs");

  assert.match(block, /security invoker/i);
  assert.match(block, /for update/i);
  for (const stage of [
    "generating",
    "research_queued",
    "researching",
    "validating",
    "saving",
  ]) {
    assert.match(block, new RegExp(`'${stage}'`));
  }
  assert.match(block, /if payload_count > 8 then/i);
  assert.ok(deleteIndex >= 0);
  assert.ok(deleteIndex < insertIndex);
  assert.ok(insertIndex < runUpdateIndex);
  assert.match(block, /jsonb_build_object\('terra', p_terra_usage\)/i);
  assert.match(block, /from public, anon, authenticated/i);
  assert.match(block, /to service_role/i);
});

test("workflow recovers committed stage checkpoints before provider calls", () => {
  const extractionStart = workflowSource.indexOf("export async function extractSignals");
  const clusteringStart = workflowSource.indexOf("export async function buildClusters");
  const generationStart = workflowSource.indexOf(
    "export async function prepareResearchJob",
  );
  const extraction = workflowSource.slice(extractionStart, clusteringStart);
  const clustering = workflowSource.slice(clusteringStart, generationStart);

  assert.ok(extraction.indexOf("recoverSignalCheckpoint") < extraction.indexOf("callStructured"));
  assert.match(extraction, /db\.rpc\(\s*"persist_luna_checkpoint"/);
  assert.ok(clustering.indexOf('includes(run.stage)') < clustering.indexOf("callStructured"));
  assert.match(clustering, /db\.rpc\(\s*"persist_terra_checkpoint"/);
  assert.doesNotMatch(clustering, /\.from\("clusters"\)\s*\.delete\(\)/);
});

test("final publication rejects null idea or source arrays before array access", () => {
  const block = functionBlock(
    "publish_run_ideas",
    "-- ROW LEVEL SECURITY",
  );
  const nullGuardIndex = block.indexOf("if p_ideas is null");
  const arrayLengthIndex = block.indexOf("jsonb_array_length(p_ideas)");

  assert.ok(nullGuardIndex >= 0);
  assert.match(block, /or p_sources is null/i);
  assert.ok(nullGuardIndex < arrayLengthIndex);
});

test("research queue and finalizer preserve the atomic hard-gate publication contract", () => {
  assert.match(workflowSource, /db\.rpc\(\s*"persist_research_job"/);
  assert.doesNotMatch(workflowSource, /models\.ideation|gpt-5\.6-sol/);
  assert.match(finalizerSource, /db\.rpc\(\s*"begin_research_validation"/);
  assert.match(finalizerSource, /db\.rpc\(\s*"publish_run_researched_ideas"/);
  assert.match(finalizerSource, /product_spec: idea\.product_spec/);
  assert.match(finalizerSource, /hard_filter_checks: idea\.hard_filter_checks/);
  assert.match(finalizerSource, /research_candidates: groundedCandidates\.length/);
  assert.match(finalizerSource, /acceptedResearchIds/);
  assert.match(finalizerSource, /accepted\.length\s*\?\s*validated\.sources\.filter/);

  assert.match(additiveMigration, /create or replace function public\.publish_run_product_ideas/i);
  assert.match(additiveMigration, /delivery_mode}', ''\) <> 'self_serve_web_app'/i);
  assert.match(additiveMigration, /mvp_build_weeks}', ''\) !~ '\^\[2-6\]\$'/i);
  assert.match(additiveMigration, /no_custom_implementation/i);
  assert.match(additiveMigration, /from public\.publish_run_ideas/i);
  assert.match(additiveMigration, /set product_spec = item -> 'product_spec'/i);
  assert.match(additiveMigration, /hard_filter_checks = item -> 'hard_filter_checks'/i);
  assert.match(additiveMigration, /from public, anon, authenticated/i);
  assert.match(additiveMigration, /to service_role/i);

  assert.match(researchMigration, /create or replace function public\.persist_research_job/i);
  assert.match(researchMigration, /create or replace function public\.begin_research_validation/i);
  assert.match(researchMigration, /create or replace function public\.publish_run_researched_ideas/i);
  assert.match(researchMigration, /from public\.publish_run_product_ideas/i);
  assert.match(researchMigration, /if jsonb_array_length\(p_ideas\) = 0 then/i);
  assert.match(
    researchMigration,
    /if existing_job\.result is not null then[\s\S]*A failed research result cannot be reused/i,
  );
  assert.match(
    researchMigration,
    /return query select existing_job\.id, 'pending'::text;\s*return;/i,
  );
  assert.doesNotMatch(
    researchMigration,
    /if existing_job\.result is null then[\s\S]*set status = 'submitted'/i,
  );
});

test("fetch retries replace the candidate snapshot instead of leaking stale source-feed rows", () => {
  const fetchStart = workflowSource.indexOf("export async function fetchAndRank");
  const extractionStart = workflowSource.indexOf("export async function extractSignals");
  const fetchBlock = workflowSource.slice(fetchStart, extractionStart);
  const deleteIndex = fetchBlock.search(/\.from\("run_posts"\)\r?\n    \.delete\(\)/);
  const candidateUpsertIndex = fetchBlock.search(/\.from\("run_posts"\)\r?\n      \.upsert/);

  assert.ok(deleteIndex >= 0);
  assert.ok(candidateUpsertIndex > deleteIndex);
});
