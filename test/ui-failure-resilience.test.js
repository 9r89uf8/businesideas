import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEvidenceSources } from "../src/components/evidence-state.js";
import {
  describeRun,
  getRunStageLabel,
} from "../src/components/run-status-state.js";

test("failed run descriptions expose the last stage and a safe error", () => {
  const failed = describeRun({
    status: "failed",
    stage: "clustering",
    error_message: "Clustering could not be completed after safe retries.",
  });

  assert.equal(failed.label, "Needs attention");
  assert.equal(failed.lastStage, "Building opportunity clusters");
  assert.equal(
    failed.safeError,
    "Clustering could not be completed after safe retries.",
  );
  assert.equal(getRunStageLabel(null), "Not recorded");
  assert.match(
    describeRun({ status: "failed", stage: "fetching" }).safeError,
    /stopped unexpectedly/i,
  );
});

test("transient X verification failure preserves every saved evidence row", () => {
  const sourceRows = [
    { post_id: "101", signal_type: "pain", evidence_summary: "First signal" },
    { post_id: "102", signal_type: "request", evidence_summary: "Second signal" },
    { post_id: "103", signal_type: "workaround", evidence_summary: "Third signal" },
  ];
  const posts = sourceRows.map((source) => ({
    x_post_id: source.post_id,
    text: `Current source text for ${source.post_id}`,
    availability: "available",
    url: `https://x.com/example/status/${source.post_id}`,
  }));
  const runPosts = sourceRows.map((source) => ({
    post_id: source.post_id,
    evidence_excerpt: `Current source text for ${source.post_id}`,
  }));

  const sources = buildEvidenceSources({
    sourceRows,
    posts,
    runPosts,
    verificationTemporarilyUnavailable: true,
  });

  assert.equal(sources.length, 3);
  assert.deepEqual(
    sources.map((source) => source.evidence_summary),
    ["First signal", "Second signal", "Third signal"],
  );
  assert.ok(sources.every((source) => source.temporarilyUnverified));
  assert.ok(sources.every((source) => source.post.availability === "unknown"));
  assert.ok(sources.every((source) => source.exactExcerpt === null));
});

test("confirmed unavailable evidence remains unavailable during an X outage", () => {
  const [source] = buildEvidenceSources({
    sourceRows: [
      { post_id: "404", signal_type: "pain", evidence_summary: "Gone" },
    ],
    posts: [{ x_post_id: "404", text: null, availability: "unavailable" }],
    runPosts: [],
    verificationTemporarilyUnavailable: true,
  });

  assert.equal(source.post.availability, "unavailable");
  assert.equal(source.temporarilyUnverified, false);
});
