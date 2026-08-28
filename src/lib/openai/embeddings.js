import "server-only";

import { PIPELINE } from "../config.js";
import { createOpenAIClient } from "./client.js";

const MAX_EMBEDDING_INPUTS = 2048;

function normalizeTokenCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

export function normalizeEmbeddingUsage(usage) {
  return {
    input_tokens: normalizeTokenCount(
      usage?.prompt_tokens ?? usage?.input_tokens,
    ),
  };
}

function assertEmbeddingInputs(inputs) {
  if (!Array.isArray(inputs)) {
    throw new TypeError("Embedding input must be an array of strings.");
  }

  if (inputs.length > MAX_EMBEDDING_INPUTS) {
    throw new RangeError(
      `Embedding input cannot contain more than ${MAX_EMBEDDING_INPUTS} items.`,
    );
  }

  if (
    inputs.some(
      (input) => typeof input !== "string" || input.trim().length === 0,
    )
  ) {
    throw new TypeError("Embedding inputs must be non-empty strings.");
  }
}

export async function embedTexts(
  inputs,
  { model = PIPELINE.models.embedding, dimensions } = {},
) {
  assertEmbeddingInputs(inputs);

  if (typeof model !== "string" || !model.trim()) {
    throw new TypeError("An embedding model is required.");
  }

  if (
    dimensions !== undefined &&
    (!Number.isInteger(dimensions) || dimensions < 1)
  ) {
    throw new TypeError("Embedding dimensions must be a positive integer.");
  }

  if (inputs.length === 0) {
    return {
      embeddings: [],
      usage: { input_tokens: 0 },
      model,
    };
  }

  const request = {
    model,
    input: inputs,
    encoding_format: "float",
  };

  if (dimensions !== undefined) {
    request.dimensions = dimensions;
  }

  const response = await createOpenAIClient().embeddings.create(request);
  const embeddings = Array(inputs.length);
  let embeddingLength;

  for (const item of response.data ?? []) {
    if (
      !Number.isInteger(item?.index) ||
      item.index < 0 ||
      item.index >= inputs.length ||
      !Array.isArray(item.embedding) ||
      item.embedding.length === 0 ||
      item.embedding.some((value) => !Number.isFinite(value)) ||
      (dimensions !== undefined && item.embedding.length !== dimensions) ||
      embeddings[item.index]
    ) {
      throw new Error("OpenAI returned malformed embedding data.");
    }

    if (
      embeddingLength !== undefined &&
      item.embedding.length !== embeddingLength
    ) {
      throw new Error("OpenAI returned inconsistent embedding dimensions.");
    }

    embeddingLength = item.embedding.length;
    embeddings[item.index] = item.embedding;
  }

  for (let index = 0; index < embeddings.length; index += 1) {
    if (!Array.isArray(embeddings[index])) {
      throw new Error("OpenAI returned an incomplete embedding result.");
    }
  }

  return {
    embeddings,
    usage: normalizeEmbeddingUsage(response.usage),
    model: response.model ?? model,
  };
}
