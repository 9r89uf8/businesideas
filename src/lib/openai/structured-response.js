import "server-only";

import { createOpenAIClient } from "./client.js";

function normalizeTokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function normalizeResponseUsage(usage) {
  return {
    input_tokens: normalizeTokenCount(usage?.input_tokens),
    output_tokens: normalizeTokenCount(usage?.output_tokens),
  };
}

function assertStructuredRequest({
  model,
  reasoningEffort,
  schemaName,
  schema,
  input,
  maxOutputTokens,
}) {
  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("A model is required for a structured response.");
  }

  if (typeof reasoningEffort !== "string" || !reasoningEffort.trim()) {
    throw new TypeError("A reasoning effort is required for a structured response.");
  }

  if (typeof schemaName !== "string" || !schemaName.trim()) {
    throw new TypeError("A schema name is required for a structured response.");
  }

  if (!schema || schema.type !== "object") {
    throw new TypeError("Structured response schemas must be root objects.");
  }

  if (
    (typeof input !== "string" && !Array.isArray(input)) ||
    (typeof input === "string" && !input.trim()) ||
    (Array.isArray(input) && input.length === 0)
  ) {
    throw new TypeError("Structured response input must not be empty.");
  }

  if (
    maxOutputTokens !== undefined &&
    (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)
  ) {
    throw new TypeError("maxOutputTokens must be a positive integer.");
  }
}

export async function callStructured({
  model,
  reasoningEffort,
  schemaName,
  schema,
  input,
  maxOutputTokens,
}) {
  assertStructuredRequest({
    model,
    reasoningEffort,
    schemaName,
    schema,
    input,
    maxOutputTokens,
  });

  const request = {
    model,
    reasoning: {
      effort: reasoningEffort,
    },
    input,
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        strict: true,
        schema,
      },
    },
    store: false,
  };

  if (maxOutputTokens !== undefined) {
    request.max_output_tokens = maxOutputTokens;
  }

  const response = await createOpenAIClient().responses.create(request);

  if (response.status && response.status !== "completed") {
    throw new Error(`Structured response from ${model} did not complete.`);
  }

  const outputText = response.output_text;

  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error(`No structured output returned by ${model}.`);
  }

  let data;

  try {
    data = JSON.parse(outputText);
  } catch (error) {
    throw new Error(`Invalid structured output returned by ${model}.`, {
      cause: error,
    });
  }

  return {
    data,
    usage: normalizeResponseUsage(response.usage),
    responseId: response.id ?? null,
    model: response.model ?? model,
  };
}
