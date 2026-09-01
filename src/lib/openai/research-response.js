import { researchResultSchema, RESEARCH_RESULT_SCHEMA_NAME } from "../ai-schemas/idea-generation.js";
import { PIPELINE } from "../config.js";
import { RESEARCH_WORKER_INSTRUCTIONS } from "../prompts/generate-ideas.js";
import { normalizePublicResearchUrl } from "../research/public-url.js";

export const RESEARCH_RESPONSE_LIMITS = Object.freeze({
  model: PIPELINE.models.research,
  reasoningEffort: PIPELINE.reasoning.research,
  maxToolCalls: PIPELINE.research.maxToolCalls,
  maxOutputTokens: PIPELINE.research.maxOutputTokens,
  maxPayloadBytes: PIPELINE.research.maxResultBytes,
  searchContextSize: PIPELINE.research.searchContextSize,
});

const STRUCTURAL_SCHEMA_KEYWORDS = new Set([
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
]);

function normalizeCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function encodedSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const PRIVATE_PROMPT_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "capability",
  "capabilities",
  "claimid",
  "claim_id",
  "claimtoken",
  "claim_token",
  "ownerid",
  "owner_id",
  "password",
  "refreshtoken",
  "refresh_token",
  "secret",
  "servicerolekey",
  "service_role_key",
  "token",
]);

function assertSafePayload(value, path = "payload", seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new TypeError("Research payload must be serializable JSON.");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertSafePayload(item, `${path}[${index}]`, seen),
    );
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_PROMPT_KEYS.has(key.toLowerCase())) {
        throw new TypeError(`Research payload contains private field ${path}.${key}.`);
      }
      assertSafePayload(item, `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
}

function boundedIdentifier(value, name) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded identifier.`);
  }
  return value;
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !value) {
    throw new TypeError("accessedAt must be a server-generated ISO timestamp.");
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError("accessedAt must be a canonical ISO timestamp.");
  }
  return value;
}

function cloneApiSchema(value, path = "root") {
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneApiSchema(item, `${path}[${index}]`));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const clone = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "uniqueItems") {
      continue;
    }
    if (STRUCTURAL_SCHEMA_KEYWORDS.has(key)) {
      throw new TypeError(
        `Research schema uses unsupported Structured Outputs keyword ${key} at ${path}.`,
      );
    }
    clone[key] = cloneApiSchema(item, `${path}.${key}`);
  }
  return clone;
}

function assertStrictSchemaObjects(schema, path = "root") {
  if (!schema || typeof schema !== "object") return;

  if (schema.type === "object") {
    if (
      !schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties) ||
      schema.additionalProperties !== false
    ) {
      throw new TypeError(
        `Research schema object ${path} must define properties and reject additional properties.`,
      );
    }

    const propertyNames = Object.keys(schema.properties);
    if (
      !Array.isArray(schema.required) ||
      schema.required.length !== propertyNames.length ||
      propertyNames.some((name) => !schema.required.includes(name))
    ) {
      throw new TypeError(
        `Research schema object ${path} must require every declared property.`,
      );
    }

    for (const [name, property] of Object.entries(schema.properties)) {
      assertStrictSchemaObjects(property, `${path}.${name}`);
    }
  }

  if (schema.type === "array") {
    assertStrictSchemaObjects(schema.items, `${path}[]`);
  }

  for (const [index, branch] of (schema.anyOf ?? []).entries()) {
    assertStrictSchemaObjects(branch, `${path}.anyOf[${index}]`);
  }
}

/**
 * Produces the schema sent to Responses without weakening the database-side
 * contract. OpenAI Structured Outputs does not support `uniqueItems`; the
 * existing result validator remains responsible for those uniqueness checks.
 */
export function toOpenAIResearchSchema(schema = researchResultSchema) {
  if (!schema || schema.type !== "object" || Object.hasOwn(schema, "anyOf")) {
    throw new TypeError("Research Structured Outputs schemas must be root objects.");
  }

  const apiSchema = cloneApiSchema(schema);
  assertStrictSchemaObjects(apiSchema);
  return apiSchema;
}

export function buildResearchPromptInput({
  jobId,
  promptVersion,
  payload,
  accessedAt,
} = {}) {
  const safeJobId = boundedIdentifier(jobId, "jobId");
  const safePromptVersion = boundedIdentifier(promptVersion, "promptVersion");
  const safeAccessedAt = canonicalTimestamp(accessedAt);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("Research payload must be an object.");
  }
  if (payload.prompt_version !== safePromptVersion) {
    throw new TypeError("Research payload prompt version does not match the job.");
  }

  assertSafePayload(payload);
  if (encodedSize(payload) > RESEARCH_RESPONSE_LIMITS.maxPayloadBytes) {
    throw new RangeError("Research payload exceeds the maximum allowed size.");
  }

  let safePayload;
  try {
    safePayload = JSON.parse(JSON.stringify(payload));
  } catch (error) {
    throw new TypeError("Research payload must be serializable JSON.", {
      cause: error,
    });
  }

  const envelope = {
    job_id: safeJobId,
    prompt_version: safePromptVersion,
    accessed_at: safeAccessedAt,
    payload: safePayload,
  };

  return [
    {
      role: "system",
      content: `${RESEARCH_WORKER_INSTRUCTIONS}\n\nFor every source, set accessed_at to exactly ${safeAccessedAt}. Do not calculate, replace, or reformat this server-generated timestamp.`,
    },
    {
      role: "user",
      content: `Research and generate hypotheses for this immutable job envelope:\n${JSON.stringify(envelope)}`,
    },
  ];
}

/**
 * Builds an allowlisted Responses request. Callers cannot override the model,
 * reasoning, tool, storage, or token limits by adding fields to the argument.
 */
export function buildResearchResponseRequest({
  jobId,
  promptVersion,
  payload,
  accessedAt,
} = {}) {
  return {
    model: RESEARCH_RESPONSE_LIMITS.model,
    reasoning: {
      effort: RESEARCH_RESPONSE_LIMITS.reasoningEffort,
    },
    input: buildResearchPromptInput({
      jobId,
      promptVersion,
      payload,
      accessedAt,
    }),
    tools: [
      {
        type: "web_search",
        external_web_access: true,
        search_context_size: RESEARCH_RESPONSE_LIMITS.searchContextSize,
      },
    ],
    tool_choice: "auto",
    max_tool_calls: RESEARCH_RESPONSE_LIMITS.maxToolCalls,
    include: ["web_search_call.action.sources"],
    text: {
      format: {
        type: "json_schema",
        name: RESEARCH_RESULT_SCHEMA_NAME,
        strict: true,
        schema: toOpenAIResearchSchema(),
      },
    },
    max_output_tokens: RESEARCH_RESPONSE_LIMITS.maxOutputTokens,
    background: true,
    store: true,
  };
}

function addPublicUrl(target, value) {
  const normalized = normalizePublicResearchUrl(value);
  if (normalized) target.add(normalized);
}

function sortedValues(values) {
  return [...values].sort();
}

export function extractWebSearchEvidence(response) {
  const discovered = new Set();
  const opened = new Set();
  const cited = new Set();
  let completedWebSearchCalls = 0;

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === "web_search_call" && item.status === "completed") {
      completedWebSearchCalls += 1;
      const action = item.action;

      if (action && typeof action === "object") {
        for (const source of Array.isArray(action.sources) ? action.sources : []) {
          addPublicUrl(discovered, source?.url);
        }

        if (action.type === "open_page" || action.type === "find_in_page") {
          addPublicUrl(discovered, action.url);
          addPublicUrl(opened, action.url);
        }
      }
    }

    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      for (const annotation of Array.isArray(content?.annotations)
        ? content.annotations
        : []) {
        if (annotation?.type !== "url_citation") continue;
        addPublicUrl(discovered, annotation.url);
        addPublicUrl(cited, annotation.url);
      }
    }
  }

  const observed = new Set([...opened, ...cited]);
  return {
    completedWebSearchCalls,
    discoveredUrls: sortedValues(discovered),
    openedUrls: sortedValues(opened),
    citedUrls: sortedValues(cited),
    observedUrls: sortedValues(observed),
  };
}

export function normalizeResearchResponseUsage(usage, webSearchCalls = 0) {
  const inputTokens = normalizeCount(usage?.input_tokens);
  const outputTokens = normalizeCount(usage?.output_tokens);
  const suppliedTotal = normalizeCount(usage?.total_tokens);

  return {
    input_tokens: inputTokens,
    cached_input_tokens: normalizeCount(
      usage?.input_tokens_details?.cached_tokens,
    ),
    output_tokens: outputTokens,
    reasoning_tokens: normalizeCount(
      usage?.output_tokens_details?.reasoning_tokens,
    ),
    total_tokens: suppliedTotal || inputTokens + outputTokens,
    web_search_calls: normalizeCount(webSearchCalls),
  };
}

function outputParts(response) {
  return (Array.isArray(response?.output) ? response.output : [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
}

function extractOutputText(response) {
  const parts = outputParts(response);
  if (parts.some((part) => part?.type === "refusal" || part?.refusal)) {
    throw new Error("OpenAI refused the research response.");
  }

  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }

  const text = parts
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");

  if (!text.trim()) {
    throw new Error("OpenAI returned no structured research output.");
  }
  return text;
}

export function assertResearchSourcesGrounded(data, evidence) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Array.isArray(data.sources) ||
    !Array.isArray(data.ideas)
  ) {
    throw new TypeError("OpenAI research output is missing source or idea arrays.");
  }

  if (
    (data.ideas.length > 0 || data.sources.length > 0) &&
    evidence.completedWebSearchCalls < 1
  ) {
    throw new Error("OpenAI returned researched output without a completed web search.");
  }

  const observedUrls = new Set(evidence.observedUrls);
  const groundedSourceUrls = [];
  for (const [index, source] of data.sources.entries()) {
    const normalized = normalizePublicResearchUrl(source?.url);
    if (!normalized) {
      throw new Error(`OpenAI research source ${index} has an unsafe or invalid URL.`);
    }
    if (!observedUrls.has(normalized)) {
      throw new Error(`OpenAI research source ${index} was not opened or cited.`);
    }
    groundedSourceUrls.push(normalized);
  }

  return groundedSourceUrls;
}

export function parseResearchResponse(response, { accessedAt } = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("OpenAI research response must be an object.");
  }
  if (response.status !== "completed") {
    const status =
      typeof response.status === "string" && response.status
        ? response.status
        : "unknown";
    throw new Error(`OpenAI research response did not complete (${status}).`);
  }
  if (response.error) {
    throw new Error("OpenAI research response completed with an error.");
  }

  const outputText = extractOutputText(response);
  let data;
  try {
    data = JSON.parse(outputText);
  } catch (error) {
    throw new Error("OpenAI returned invalid structured research JSON.", {
      cause: error,
    });
  }

  if (accessedAt !== undefined) {
    const expectedAccessedAt = canonicalTimestamp(accessedAt);
    if (
      !Array.isArray(data?.sources) ||
      data.sources.some((source) => source?.accessed_at !== expectedAccessedAt)
    ) {
      throw new Error(
        "OpenAI research sources did not preserve the server access timestamp.",
      );
    }
  }

  const webSearchEvidence = extractWebSearchEvidence(response);
  const groundedSourceUrls = assertResearchSourcesGrounded(
    data,
    webSearchEvidence,
  );

  return {
    data,
    usage: normalizeResearchResponseUsage(
      response.usage,
      webSearchEvidence.completedWebSearchCalls,
    ),
    responseId:
      typeof response.id === "string" && response.id ? response.id : null,
    model:
      typeof response.model === "string" && response.model
        ? response.model
        : RESEARCH_RESPONSE_LIMITS.model,
    webSearchEvidence,
    groundedSourceUrls,
  };
}
