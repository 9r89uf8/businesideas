import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  cosineSimilarity,
  duplicatesAcceptedIdea,
  isSemanticIdeaDuplicate,
} from "../src/lib/idea-deduplication.js";

const accepted = {
  fingerprint_hash: "first-hash",
  target_customer: "small accounting firms",
  problem: "manual review of AI-generated client work",
  embedding: [1, 0, 0],
};

test("same-batch deduplication rejects exact and semantic sibling ideas", () => {
  assert.equal(
    duplicatesAcceptedIdea(
      {
        fingerprint_hash: "first-hash",
        target_customer: "different customer",
        problem: "different problem",
      },
      [0, 1, 0],
      [accepted],
    ),
    true,
  );

  assert.equal(
    duplicatesAcceptedIdea(
      {
        fingerprint_hash: "second-hash",
        target_customer: "accounting firms",
        problem: "AI generated client work needs manual review",
      },
      [1, 0, 0],
      [accepted],
    ),
    true,
  );

  assert.equal(
    duplicatesAcceptedIdea(
      {
        fingerprint_hash: "third-hash",
        target_customer: "independent game studios",
        problem: "localization asset coordination",
      },
      [1, 0, 0],
      [accepted],
    ),
    false,
  );
});

test("semantic duplicate checks use cosine similarity and matching commercial scope", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), -1);
  assert.equal(
    isSemanticIdeaDuplicate(
      accepted,
      {
        target_customer: "accounting firms",
        problem: "manual review for AI generated client work",
      },
      0.91,
    ),
    true,
  );
  assert.equal(isSemanticIdeaDuplicate(accepted, accepted, 0.89), false);
});

test("workflow and vector RPC pass the current run exclusion together", () => {
  const workflowSource = readFileSync(
    new URL("../src/workflows/daily-research-steps.js", import.meta.url),
    "utf8",
  );
  const migrationSource = readFileSync(
    new URL("../supabase/migrations/001_initial_schema.sql", import.meta.url),
    "utf8",
  );

  assert.equal(
    workflowSource.match(/p_exclude_run_id: runId/g)?.length,
    2,
  );
  assert.match(migrationSource, /p_exclude_run_id uuid/);
  assert.match(migrationSource, /i\.run_id <> p_exclude_run_id/);
});
