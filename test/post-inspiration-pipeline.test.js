import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_GENERATION_SCHEMA_NAME,
  candidateGenerationSchema,
} from "../src/lib/ai-schemas/candidate-generation.js";
import {
  CONTEXT_HYDRATION_SCHEMA_NAME,
  contextHydrationSchema,
} from "../src/lib/ai-schemas/context-hydration.js";
import {
  POST_FILTER_SCHEMA_NAME,
  postFilterSchema,
} from "../src/lib/ai-schemas/post-filter.js";
import {
  POST_SHORTLIST_SCHEMA_NAME,
  postShortlistSchema,
} from "../src/lib/ai-schemas/post-shortlist.js";
import {
  CANDIDATE_GENERATION_INSTRUCTIONS,
  buildCandidateGenerationPrompt,
} from "../src/lib/prompts/candidate-generation.js";
import {
  CONTEXT_HYDRATION_INSTRUCTIONS,
  buildContextHydrationPrompt,
} from "../src/lib/prompts/context-hydration.js";
import {
  POST_FILTER_INSTRUCTIONS,
  buildPostFilterPrompt,
} from "../src/lib/prompts/post-filter.js";
import {
  POST_SHORTLIST_INSTRUCTIONS,
  buildPostShortlistPrompt,
} from "../src/lib/prompts/post-shortlist.js";

function assertStrictObjects(schema, path = "root") {
  if (!schema || typeof schema !== "object") return;

  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false, `${path} must be strict`);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${path} must require every property`,
    );
    for (const [key, value] of Object.entries(schema.properties)) {
      assertStrictObjects(value, `${path}.${key}`);
    }
  }
  if (schema.type === "array") assertStrictObjects(schema.items, `${path}[]`);
  for (const [index, branch] of (schema.anyOf ?? []).entries()) {
    assertStrictObjects(branch, `${path}.anyOf[${index}]`);
  }
}

function payloadFrom(messages) {
  return JSON.parse(messages[1].content.slice(messages[1].content.indexOf("\n") + 1));
}

function posts(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    text: `Post ${index + 1} announces a concrete capability.`,
  }));
}

test("new pipeline schemas are strict and expose the 30-post and 8-post caps", () => {
  assert.deepEqual(
    [
      POST_FILTER_SCHEMA_NAME,
      CONTEXT_HYDRATION_SCHEMA_NAME,
      POST_SHORTLIST_SCHEMA_NAME,
      CANDIDATE_GENERATION_SCHEMA_NAME,
    ],
    ["post_filter", "context_hydration", "post_shortlist", "candidate_generation"],
  );

  for (const schema of [
    postFilterSchema,
    contextHydrationSchema,
    postShortlistSchema,
    candidateGenerationSchema,
  ]) {
    assertStrictObjects(schema);
  }

  assert.equal(postFilterSchema.properties.items.maxItems, 30);
  assert.deepEqual(postFilterSchema.properties.items.items.properties.decision.enum, [
    "keep",
    "reject",
    "needs_context",
  ]);
  assert.equal(contextHydrationSchema.properties.items.maxItems, 30);
  assert.equal(postShortlistSchema.properties.assessments.maxItems, 30);
  assert.equal(postShortlistSchema.properties.advanced_post_ids.maxItems, 8);
  assert.equal(candidateGenerationSchema.properties.concepts_considered.minItems, 3);
  assert.equal(candidateGenerationSchema.properties.concepts_considered.maxItems, 3);
  assert.ok(
    candidateGenerationSchema.properties.selected_idea.anyOf.some(
      (branch) => branch.type === "null",
    ),
  );
});

test("filter and hydration builders preserve bounded, untrusted source data", () => {
  const filterMessages = buildPostFilterPrompt([
    { id: "123", text: "Stripe launched usage-based billing alerts." },
  ]);
  assert.equal(filterMessages[0].content, POST_FILTER_INSTRUCTIONS);
  assert.deepEqual(payloadFrom(filterMessages), {
    posts: [{ post_id: "123", text: "Stripe launched usage-based billing alerts." }],
  });
  assert.match(POST_FILTER_INSTRUCTIONS, /information content, not writing length/);

  const hydrationMessages = buildContextHydrationPrompt([
    {
      post_id: "123",
      text: "This is a big deal.",
      context_sources: [
        {
          type: "link",
          url: "https://example.com/launch",
          title: "Launch notes",
          text: "The API now emits billing alerts.",
        },
      ],
    },
  ]);
  assert.equal(hydrationMessages[0].content, CONTEXT_HYDRATION_INSTRUCTIONS);
  assert.deepEqual(payloadFrom(hydrationMessages).posts[0].context_sources, [
    {
      kind: "link",
      url: "https://example.com/launch",
      title: "Launch notes",
      content: "The API now emits billing alerts.",
    },
  ]);

  assert.throws(() => buildPostFilterPrompt(posts(31)), /at most 30 posts/);
  assert.throws(() => buildContextHydrationPrompt(posts(31)), /at most 30 posts/);
});

test("shortlist builder assesses all survivors while keeping advancement capped", () => {
  const messages = buildPostShortlistPrompt([
    {
      id: "7",
      text: "A new API turns recordings into localized release assets.",
      commercial_element: "capability",
      context_summary: "The launch supports structured localized output.",
    },
  ]);
  assert.equal(messages[0].content, POST_SHORTLIST_INSTRUCTIONS);
  assert.equal(payloadFrom(messages).posts[0].post_id, "7");
  assert.match(POST_SHORTLIST_INSTRUCTIONS, /Assess every input post/);
  assert.match(POST_SHORTLIST_INSTRUCTIONS, /no more than eight posts/);
  assert.throws(() => buildPostShortlistPrompt(posts(31)), /at most 30 posts/);
});

test("candidate generation is one-post-only and permits an explicit no-idea result", () => {
  const messages = buildCandidateGenerationPrompt({
    id: "42",
    text: "A release API can now produce localized launch assets.",
    context_summary: "The source product supplies generation but not approvals.",
  });
  assert.equal(messages[0].content, CANDIDATE_GENERATION_INSTRUCTIONS);
  assert.deepEqual(payloadFrom(messages), {
    post_id: "42",
    text: "A release API can now produce localized launch assets.",
    context_summary: "The source product supplies generation but not approvals.",
    preferences: {
      offer_bias: "",
      preferred_customers: [],
      preferred_business_models: [],
      avoid: [],
      personal_advantages: [],
    },
  });
  assert.match(CANDIDATE_GENERATION_INSTRUCTIONS, /exactly three materially different/);
  assert.match(CANDIDATE_GENERATION_INSTRUCTIONS, /no_viable_idea/);
  assert.match(CANDIDATE_GENERATION_INSTRUCTIONS, /Do not use web search/);
  assert.throws(
    () => buildCandidateGenerationPrompt(posts(2)),
    /exactly one post object/,
  );
});
