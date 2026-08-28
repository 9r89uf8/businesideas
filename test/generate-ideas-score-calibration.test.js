import assert from "node:assert/strict";
import test from "node:test";

import { ideaGenerationSchema } from "../src/lib/ai-schemas/idea-generation.js";
import { GENERATE_IDEAS_INSTRUCTIONS } from "../src/lib/prompts/generate-ideas.js";

test("Sol receives an explicit 0-to-100 evidence score calibration", () => {
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /full 0-to-100 scale/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /Never use a 0-to-10 or 0-to-1 scale/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /0 means/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /50 means/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /75 means/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /100 means/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /not model confidence/);
});

test("Sol's evidence_score schema documents the same full scale", () => {
  const score = ideaGenerationSchema.properties.ideas.items.properties.evidence_score;

  assert.equal(score.minimum, 0);
  assert.equal(score.maximum, 100);
  assert.match(score.description, /full 0-to-100 scale/);
  assert.match(score.description, /never 0-to-10 or 0-to-1/);
  assert.match(score.description, /0 unsupported/);
  assert.match(score.description, /50 moderate/);
  assert.match(score.description, /75 strong/);
  assert.match(score.description, /100 exceptionally direct/);
  assert.match(score.description, /not model confidence/);
});
