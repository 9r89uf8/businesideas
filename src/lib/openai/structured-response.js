import "server-only";

import { createOpenAIClient } from "./client.js";

function normalizeTokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function normalizeResponseUsage(usage) {
  const inputTokens = normalizeTokenCount(usage?.input_tokens);
  const outputTokens = normalizeTokenCount(usage?.output_tokens);
  return {
    input_tokens: inputTokens,
    cached_input_tokens: normalizeTokenCount(
      usage?.input_tokens_details?.cached_tokens,
    ),
    output_tokens: outputTokens,
    reasoning_tokens: normalizeTokenCount(
      usage?.output_tokens_details?.reasoning_tokens,
    ),
    total_tokens:
      normalizeTokenCount(usage?.total_tokens) || inputTokens + outputTokens,
  };
}

function assertStructuredRequest({
  model,
  reasoningEffort,
  schemaName,
  schema,
  input,
  maxOutputTokens,
  tools,
  maxToolCalls,
  promptCacheKey,
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

  if (tools !== undefined && (!Array.isArray(tools) || tools.length === 0)) {
    throw new TypeError("tools must be a non-empty array when supplied.");
  }

  if (
    maxToolCalls !== undefined &&
    (!Number.isInteger(maxToolCalls) || maxToolCalls < 1)
  ) {
    throw new TypeError("maxToolCalls must be a positive integer.");
  }

  if (
    promptCacheKey !== undefined &&
    (typeof promptCacheKey !== "string" ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(promptCacheKey))
  ) {
    throw new TypeError("promptCacheKey must be a bounded cache identifier.");
  }
}

export async function callStructured({
  model,
  reasoningEffort,
  schemaName,
  schema,
  input,
  maxOutputTokens,
  tools,
  toolChoice,
  maxToolCalls,
  include,
  promptCacheKey,
}) {
  assertStructuredRequest({
    model,
    reasoningEffort,
    schemaName,
    schema,
    input,
    maxOutputTokens,
    tools,
    maxToolCalls,
    promptCacheKey,
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
  if (tools !== undefined) {
    request.tools = tools;
    request.tool_choice = toolChoice ?? "auto";
  }
  if (maxToolCalls !== undefined) {
    request.max_tool_calls = maxToolCalls;
  }
  if (include !== undefined) {
    request.include = include;
  }
  if (promptCacheKey !== undefined) {
    request.prompt_cache_key = promptCacheKey;
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
