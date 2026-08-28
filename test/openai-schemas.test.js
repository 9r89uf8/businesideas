import assert from "node:assert/strict";
import test from "node:test";

import { PIPELINE } from "../src/lib/config.js";
import { clusterGenerationSchema } from "../src/lib/ai-schemas/cluster-generation.js";
import { ideaGenerationSchema } from "../src/lib/ai-schemas/idea-generation.js";
import { signalExtractionSchema } from "../src/lib/ai-schemas/signal-extraction.js";

function assertStrictObjects(schema, path = "root") {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (schema.type === "object") {
    assert.equal(
      schema.additionalProperties,
      false,
      `${path} must reject additional properties`,
    );
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${path} must require every declared property`,
    );

    for (const [key, value] of Object.entries(schema.properties)) {
      assertStrictObjects(value, `${path}.${key}`);
    }
  }

  if (schema.type === "array") {
    assertStrictObjects(schema.items, `${path}[]`);
  }

  for (const [index, branch] of (schema.anyOf ?? []).entries()) {
    assertStrictObjects(branch, `${path}.anyOf[${index}]`);
  }
}

test("all OpenAI schemas use strict, fully-required objects", () => {
  for (const schema of [
    signalExtractionSchema,
    clusterGenerationSchema,
    ideaGenerationSchema,
  ]) {
    assert.equal(schema.type, "object");
    assertStrictObjects(schema);
  }
});

test("signal extraction schema matches the Luna contract", () => {
  const items = signalExtractionSchema.properties.items;
  const item = items.items;

  assert.equal(items.maxItems, PIPELINE.defaultAiInputLimit);
  assert.deepEqual(item.properties.signal_type.enum, [
    "pain",
    "request",
    "workaround",
    "spending",
    "new_capability",
    "hype",
    "none",
  ]);
  assert.equal(item.properties.commercial_score.minimum, 0);
  assert.equal(item.properties.commercial_score.maximum, 100);
  assert.equal(item.properties.hype_score.minimum, 0);
  assert.equal(item.properties.hype_score.maximum, 100);
});

test("cluster schema requires evidence and caps Terra output", () => {
  const clusters = clusterGenerationSchema.properties.clusters;
  const evidence = clusters.items.properties.evidence_post_ids;

  assert.equal(clusters.maxItems, PIPELINE.maxClusters);
  assert.equal(evidence.minItems, PIPELINE.minimumEvidencePosts);
  assert.ok(clusters.items.required.includes("evidence_post_ids"));
});

test("idea schema permits zero to five complete Sol candidates", () => {
  const ideas = ideaGenerationSchema.properties.ideas;
  const idea = ideas.items;

  assert.equal(ideas.minItems, undefined);
  assert.equal(ideas.maxItems, PIPELINE.maxGeneratedCandidates);
  assert.equal(
    idea.properties.source_post_ids.minItems,
    PIPELINE.minimumEvidencePosts,
  );
  assert.ok(idea.required.includes("risks"));
  assert.ok(idea.required.includes("assumptions"));
  assert.ok(!Object.hasOwn(idea.properties, "confidence"));
});
