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
const workflowSource = readFileSync(
  new URL("../src/workflows/daily-research-steps.js", import.meta.url),
  "utf8",
);

function functionBlock(name, nextMarker) {
  const start = migration.indexOf(`create or replace function public.${name}(`);
  const end = migration.indexOf(nextMarker, start);

  assert.notEqual(start, -1, `${name} must exist in the migration`);
  assert.notEqual(end, -1, `${name} must have a bounded migration block`);
  return migration.slice(start, end);
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
    "-- Terra output, usage, counts",
  );

  assert.match(block, /security invoker/i);
  assert.match(block, /for update/i);
  assert.match(block, /current_stage in \('clustering', 'generating', 'saving'\)/i);
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
    "-- Final publication is one transaction",
  );
  const deleteIndex = block.indexOf("delete from public.clusters");
  const insertIndex = block.indexOf("insert into public.clusters");
  const runUpdateIndex = block.indexOf("update public.runs");

  assert.match(block, /security invoker/i);
  assert.match(block, /for update/i);
  assert.match(block, /current_stage in \('generating', 'saving'\)/i);
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
    "export async function generateDeduplicateAndSave",
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
