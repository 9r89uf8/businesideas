import assert from "node:assert/strict";
import { test } from "node:test";

import { researchResultSchema } from "../src/lib/ai-schemas/idea-generation.js";
import {
  RESEARCH_RESPONSE_LIMITS,
  assertResearchSourcesGrounded,
  buildResearchPromptInput,
  buildResearchResponseRequest,
  extractWebSearchEvidence,
  parseResearchResponse,
  toOpenAIResearchSchema,
} from "../src/lib/openai/research-response.js";

const JOB_ID = "00000000-0000-4000-8000-000000000021";
const PROMPT_VERSION = "scheduled_research_v1";
const ACCESSED_AT = "2026-08-29T15:00:00.000Z";

function jobPayload(overrides = {}) {
  return {
    schema_version: 1,
    prompt_version: PROMPT_VERSION,
    run_id: "00000000-0000-4000-8000-000000000001",
    research_as_of: "2026-08-29T00:00:00.000Z",
    preferences: {},
    product_contract: {},
    clusters: [],
    historical_ideas: [],
    ...overrides,
  };
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
    return keys;
  }
  if (!value || typeof value !== "object") return keys;

  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    collectKeys(item, keys);
  }
  return keys;
}

function completedResponse({ data, output = [], usage } = {}) {
  return {
    id: "resp_research_1",
    model: "gpt-5.6-sol-2026-08-01",
    status: "completed",
    output_text: JSON.stringify(
      data ?? {
        schema_version: 1,
        assessment: { overall_evidence: "insufficient", notes: "No idea." },
        sources: [],
        ideas: [],
      },
    ),
    output,
    usage,
  };
}

test("builds one fixed, bounded Sol/high background request", () => {
  const secret = "must-not-cross-the-request-boundary";
  const request = buildResearchResponseRequest({
    jobId: JOB_ID,
    promptVersion: PROMPT_VERSION,
    payload: jobPayload(),
    accessedAt: ACCESSED_AT,
    apiKey: secret,
    capabilities: ["database_write"],
    ownerId: secret,
    claimId: secret,
    model: "caller-controlled-model",
    max_tool_calls: 999,
  });

  assert.equal(request.model, "gpt-5.6-sol");
  assert.deepEqual(request.reasoning, { effort: "high" });
  assert.equal(request.background, true);
  assert.equal(request.store, true);
  assert.equal(request.max_tool_calls, 20);
  assert.equal(request.max_output_tokens, 32_000);
  assert.equal(request.tool_choice, "auto");
  assert.deepEqual(request.include, ["web_search_call.action.sources"]);
  assert.deepEqual(request.tools, [
    {
      type: "web_search",
      external_web_access: true,
      search_context_size: "medium",
    },
  ]);
  assert.equal(request.input.length, 2);
  assert.equal(request.input[0].role, "system");
  assert.match(request.input[0].content, /open every page you cite/i);
  assert.match(
    request.input[0].content,
    new RegExp(`accessed_at to exactly ${ACCESSED_AT}`),
  );
  assert.equal(request.input[1].role, "user");
  const envelope = JSON.parse(request.input[1].content.split("\n").at(-1));
  assert.deepEqual(Object.keys(envelope), [
    "job_id",
    "prompt_version",
    "accessed_at",
    "payload",
  ]);
  assert.equal(envelope.job_id, JOB_ID);
  assert.equal(envelope.prompt_version, PROMPT_VERSION);
  assert.equal(envelope.accessed_at, ACCESSED_AT);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "research_result");
  assert.equal(request.text.format.strict, true);
  assert.ok(!collectKeys(request).some((key) => /api.?key|authorization|secret|capabilit/i.test(key)));
  assert.ok(!JSON.stringify(request).includes(secret));
  assert.deepEqual(RESEARCH_RESPONSE_LIMITS, {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxToolCalls: 20,
    maxOutputTokens: 32_000,
    maxPayloadBytes: 1024 * 1024,
    searchContextSize: "medium",
  });
});

test("strips uniqueItems without mutating the local validation schema", () => {
  const before = JSON.stringify(researchResultSchema);
  const apiSchema = toOpenAIResearchSchema();

  assert.ok(collectKeys(researchResultSchema).includes("uniqueItems"));
  assert.ok(!collectKeys(apiSchema).includes("uniqueItems"));
  assert.equal(JSON.stringify(researchResultSchema), before);
  assert.throws(
    () =>
      toOpenAIResearchSchema({
        type: "object",
        additionalProperties: false,
        properties: {},
        required: [],
        allOf: [],
      }),
    /unsupported Structured Outputs keyword allOf/,
  );
});

test("builds a bounded prompt envelope without private job fields", () => {
  const input = buildResearchPromptInput({
    jobId: JOB_ID,
    promptVersion: PROMPT_VERSION,
    payload: jobPayload(),
    accessedAt: ACCESSED_AT,
    ownerId: "not-sent",
    claimId: "not-sent",
  });
  assert.equal(input.length, 2);
  assert.ok(!JSON.stringify(input).includes("not-sent"));
  assert.match(input[0].content, new RegExp(ACCESSED_AT.replaceAll(".", "\\.")));

  assert.throws(
    () =>
      buildResearchPromptInput({
        jobId: JOB_ID,
        promptVersion: PROMPT_VERSION,
        payload: jobPayload({ owner_id: "private-owner" }),
        accessedAt: ACCESSED_AT,
      }),
    /private field payload.owner_id/,
  );
  assert.throws(
    () =>
      buildResearchPromptInput({
        jobId: JOB_ID,
        promptVersion: "different-version",
        payload: jobPayload(),
        accessedAt: ACCESSED_AT,
      }),
    /prompt version does not match/,
  );
  assert.throws(
    () =>
      buildResearchPromptInput({
        jobId: JOB_ID,
        promptVersion: PROMPT_VERSION,
        payload: jobPayload(),
        accessedAt: "2026-08-29T10:00:00-05:00",
      }),
    /canonical ISO timestamp/,
  );
});

test("extracts discovered URLs separately from opened and cited evidence", () => {
  const evidence = extractWebSearchEvidence({
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          sources: [
            { url: "https://example.com/search-only#result" },
            { url: "http://127.0.0.1/secret" },
          ],
        },
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://example.com/opened#part" },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "{}",
            annotations: [
              {
                type: "url_citation",
                url: "https://docs.example.org/cited#section",
              },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(evidence.completedWebSearchCalls, 2);
  assert.deepEqual(evidence.discoveredUrls, [
    "https://docs.example.org/cited",
    "https://example.com/opened",
    "https://example.com/search-only",
  ]);
  assert.deepEqual(evidence.openedUrls, ["https://example.com/opened"]);
  assert.deepEqual(evidence.citedUrls, ["https://docs.example.org/cited"]);
  assert.deepEqual(evidence.observedUrls, [
    "https://docs.example.org/cited",
    "https://example.com/opened",
  ]);
});

test("parses grounded structured output and detailed usage", () => {
  const data = {
    schema_version: 1,
    assessment: { overall_evidence: "strong", notes: "Grounded." },
    sources: [
      { source_id: "web-1", url: "https://example.com/opened#fragment" },
      { source_id: "web-2", url: "https://docs.example.org/cited" },
    ],
    ideas: [{ rank: 1 }],
  };
  const response = completedResponse({
    data,
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          sources: [{ url: "https://example.com/search-only" }],
        },
      },
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "open_page", url: "https://example.com/opened" },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify(data),
            annotations: [
              { type: "url_citation", url: "https://docs.example.org/cited" },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 400 },
      output_tokens: 2_000,
      output_tokens_details: { reasoning_tokens: 1_500 },
      total_tokens: 3_000,
    },
  });

  const parsed = parseResearchResponse(response);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.responseId, "resp_research_1");
  assert.equal(parsed.model, "gpt-5.6-sol-2026-08-01");
  assert.deepEqual(parsed.groundedSourceUrls, [
    "https://example.com/opened",
    "https://docs.example.org/cited",
  ]);
  assert.deepEqual(parsed.usage, {
    input_tokens: 1_000,
    cached_input_tokens: 400,
    output_tokens: 2_000,
    reasoning_tokens: 1_500,
    total_tokens: 3_000,
    web_search_calls: 2,
  });
});

test("falls back to output message text and allows an empty researched result", () => {
  const data = {
    schema_version: 1,
    assessment: { overall_evidence: "insufficient", notes: "No idea." },
    sources: [],
    ideas: [],
  };
  const response = completedResponse({ data });
  delete response.output_text;
  response.output = [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(data), annotations: [] }],
    },
  ];

  assert.deepEqual(parseResearchResponse(response).data, data);
});

test("rejects search-only, unsafe, or searchless source claims", () => {
  const searchOnlyEvidence = {
    completedWebSearchCalls: 1,
    observedUrls: [],
  };
  assert.throws(
    () =>
      assertResearchSourcesGrounded(
        { sources: [{ url: "https://example.com/result" }], ideas: [] },
        searchOnlyEvidence,
      ),
    /was not opened or cited/,
  );
  assert.throws(
    () =>
      assertResearchSourcesGrounded(
        { sources: [{ url: "http://127.0.0.1/private" }], ideas: [] },
        { completedWebSearchCalls: 1, observedUrls: ["http://127.0.0.1/private"] },
      ),
    /unsafe or invalid URL/,
  );
  assert.throws(
    () =>
      assertResearchSourcesGrounded(
        { sources: [], ideas: [{ rank: 1 }] },
        { completedWebSearchCalls: 0, observedUrls: [] },
      ),
    /without a completed web search/,
  );
  assert.throws(
    () =>
      assertResearchSourcesGrounded(
        { sources: [{ url: "https://example.com/cited" }], ideas: [] },
        {
          completedWebSearchCalls: 0,
          observedUrls: ["https://example.com/cited"],
        },
      ),
    /without a completed web search/,
  );
});

test("rejects nonterminal, refused, empty, and invalid JSON responses", () => {
  assert.throws(
    () => parseResearchResponse({ status: "in_progress" }),
    /did not complete \(in_progress\)/,
  );
  assert.throws(
    () =>
      parseResearchResponse({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "Cannot comply" }],
          },
        ],
      }),
    /refused/,
  );
  assert.throws(
    () => parseResearchResponse({ status: "completed", output: [] }),
    /no structured research output/,
  );
  assert.throws(
    () =>
      parseResearchResponse({
        status: "completed",
        output_text: "{not-json",
        output: [],
      }),
    /invalid structured research JSON/,
  );
  assert.throws(
    () =>
      parseResearchResponse(
        completedResponse({
          data: {
            schema_version: 1,
            assessment: { overall_evidence: "weak", notes: "No candidate." },
            sources: [
              {
                url: "https://example.com/source",
                accessed_at: "2026-08-28T15:00:00.000Z",
              },
            ],
            ideas: [],
          },
        }),
        { accessedAt: ACCESSED_AT },
      ),
    /did not preserve the server access timestamp/,
  );
});
