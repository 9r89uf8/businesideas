import assert from "node:assert/strict";
import { test } from "node:test";

import { signalExtractionSchema } from "../src/lib/ai-schemas/signal-extraction.js";
import {
  EXTRACT_SIGNALS_INSTRUCTIONS,
  buildExtractSignalsPrompt,
} from "../src/lib/prompts/extract-signals.js";

test("Luna receives an explicit 0-to-100 score calibration", () => {
  assert.match(EXTRACT_SIGNALS_INSTRUCTIONS, /0-to-100 scale/);
  assert.match(EXTRACT_SIGNALS_INSTRUCTIONS, /Never use a 0-to-10 or 0-to-1 scale/);
  assert.match(EXTRACT_SIGNALS_INSTRUCTIONS, /50 = clear actionable need/);
  assert.match(EXTRACT_SIGNALS_INSTRUCTIONS, /75 = mostly excitement/);

  const item = signalExtractionSchema.properties.items.items.properties;
  assert.match(item.commercial_score.description, /full 0-to-100 scale/);
  assert.match(item.hype_score.description, /full 0-to-100 scale/);

  const prompt = buildExtractSignalsPrompt([
    { id: "123", text: "Our team still checks every AI report manually." },
  ]);
  assert.equal(prompt[0].content, EXTRACT_SIGNALS_INSTRUCTIONS);
});
