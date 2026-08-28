import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterGenerationSchema } from "../src/lib/ai-schemas/cluster-generation.js";
import {
  BUILD_CLUSTERS_INSTRUCTIONS,
  buildClustersPrompt,
} from "../src/lib/prompts/build-clusters.js";

test("Terra receives an explicit 0-to-100 score calibration", () => {
  assert.match(BUILD_CLUSTERS_INSTRUCTIONS, /full 0-to-100 scale/);
  assert.match(
    BUILD_CLUSTERS_INSTRUCTIONS,
    /Never use a 0-to-10 or 0-to-1 scale/,
  );
  assert.match(
    BUILD_CLUSTERS_INSTRUCTIONS,
    /60 = the minimum sufficiently supported cluster for ideation/,
  );
  assert.match(BUILD_CLUSTERS_INSTRUCTIONS, /75 = explicit paying/);

  const cluster =
    clusterGenerationSchema.properties.clusters.items.properties;
  assert.match(cluster.evidence_strength.description, /full 0-to-100 scale/);
  assert.match(cluster.payment_signal.description, /full 0-to-100 scale/);

  const prompt = buildClustersPrompt([
    {
      post_id: "123",
      author_id: "author-1",
      signal_type: "workaround",
      target_customer: "accounting firms",
      problem: "Staff manually verify AI-generated reports.",
      summary: "Accounting teams need reliable AI review workflows.",
      evidence_excerpt: "We manually verify every AI-generated report.",
      opportunity_score: 0.78,
    },
  ]);

  assert.equal(prompt[0].content, BUILD_CLUSTERS_INSTRUCTIONS);
});
