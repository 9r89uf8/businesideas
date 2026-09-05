import { candidateGenerationSchema, CANDIDATE_GENERATION_SCHEMA_NAME } from "../ai-schemas/candidate-generation.js";
import { postShortlistSchema, POST_SHORTLIST_SCHEMA_NAME } from "../ai-schemas/post-shortlist.js";
import { researchResultSchema, RESEARCH_RESULT_SCHEMA_NAME } from "../ai-schemas/idea-generation.js";
import { PIPELINE } from "../config.js";
import { fingerprintIdea } from "../fingerprints.js";
import { duplicatesAcceptedIdea, isSemanticIdeaDuplicate, cosineSimilarity } from "../idea-deduplication.js";
import { buildCandidateGenerationPrompt } from "../prompts/candidate-generation.js";
import { buildPostShortlistPrompt } from "../prompts/post-shortlist.js";
import { RESEARCH_WORKER_INSTRUCTIONS } from "../prompts/generate-ideas.js";
import { validateResearchResultShape } from "../validation.js";

export const CLOUD_TERMINAL_STATUSES = new Set(["completed", "no_ideas", "failed"]);
export const CLOUD_RESULT_MAX_BYTES = 256 * 1024;
export const AUTOMATIC_SHORTLIST_REASON = "The survivor set is small enough for independent generation.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireCloudRunArgs({ runId, ownerId } = {}) {
  if (!UUID.test(runId || "") || !UUID.test(ownerId || "")) {
    throw new TypeError("Cloud comparison requires valid run and owner IDs.");
  }
}

export function cloneBoundedJson(value, maximum = CLOUD_RESULT_MAX_BYTES) {
  const serialized = JSON.stringify(value);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > maximum) {
    throw new TypeError("Cloud response exceeds the JSON size limit.");
  }
  return JSON.parse(serialized);
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

// These are the schema keywords used by the existing three model contracts.
// Unlike Responses, a SQL-submitted answer receives no provider schema guarantee.
function assertSchemaValue(value, schema, path = "result") {
  const reject = () => { throw new TypeError(`Cloud response violates its schema at ${path}.`); };
  const supportedKeywords = new Set([
    "type", "anyOf", "enum", "description", "properties", "required", "additionalProperties",
    "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
  ]);
  if (Object.keys(schema).some((key) => !supportedKeywords.has(key))) {
    throw new TypeError("The cloud response schema contains an unsupported validation rule.");
  }
  if (schema.anyOf) {
    if (!schema.anyOf.some((branch) => {
      try { assertSchemaValue(value, branch, path); return true; } catch { return false; }
    })) reject();
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => matchesType(value, type))) reject();
  if (schema.enum && !schema.enum.includes(value)) reject();
  if (value === null) return;
  if (typeof value === "string") {
    if ((schema.minLength && (!value.trim() || value.length < schema.minLength)) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value))) reject();
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)) reject();
  } else if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) ||
      (schema.maxItems !== undefined && value.length > schema.maxItems) ||
      (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length)) reject();
    value.forEach((item, index) => assertSchemaValue(item, schema.items, `${path}[${index}]`));
  } else if (typeof value === "object") {
    if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) reject();
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) reject();
      } else {
        assertSchemaValue(item, schema.properties[key], `${path}.${key}`);
      }
    }
  }
}

export function validateCloudSchema(value, schema) {
  const data = cloneBoundedJson(value);
  assertSchemaValue(data, schema);
  return data;
}

export function automaticCloudShortlist(posts) {
  return {
    automatic: true,
    assessments: posts.map((post) => ({
      post_id: post.post_id,
      commercial_inspiration_score: 50,
      what_changed: post.filter_reason || post.text.slice(0, 1_000),
      possible_payer: "",
      one_line_build_angle: "",
      decision: "advance",
      reason: AUTOMATIC_SHORTLIST_REASON,
      advanced: true,
    })),
    advanced_post_ids: posts.map((post) => post.post_id),
  };
}

export function validateCloudShortlist(value, posts) {
  const data = validateCloudSchema(value, postShortlistSchema);
  const expected = new Set(posts.map((post) => post.post_id));
  const assessed = data.assessments.map((item) => item.post_id);
  const advanced = new Set(data.advanced_post_ids);
  if (assessed.length !== expected.size || new Set(assessed).size !== expected.size ||
    assessed.some((id) => !expected.has(id)) || advanced.size !== data.advanced_post_ids.length ||
    data.advanced_post_ids.some((id) => !expected.has(id)) ||
    data.assessments.some((item) => (item.decision === "advance") !== advanced.has(item.post_id))) {
    throw new TypeError("Cloud shortlist does not match its supplied posts.");
  }
  return {
    automatic: false,
    assessments: data.assessments.map((item) => ({ ...item, advanced: advanced.has(item.post_id) })),
    advanced_post_ids: data.advanced_post_ids,
  };
}

export function validateCloudCandidate(value, postId) {
  const data = validateCloudSchema(value, candidateGenerationSchema);
  if (data.source_post_id !== postId ||
    (data.status === "candidate" && data.selected_idea === null) ||
    (data.status === "no_viable_idea" && data.selected_idea !== null)) {
    throw new TypeError("Cloud generation does not match its supplied post or decision.");
  }
  return data;
}

export function validateCloudResearch(value, payload) {
  const data = validateResearchResultShape(validateCloudSchema(value, researchResultSchema));
  const candidates = new Map(payload.candidates.map((candidate) => [candidate.candidate_id, candidate.source_post.post_id]));
  if (data.ideas.some((idea) => !candidates.has(idea.candidate_id) ||
    idea.source_post_ids.length !== 1 || idea.source_post_ids[0] !== candidates.get(idea.candidate_id))) {
    throw new TypeError("Cloud research returned an unknown candidate or source post.");
  }
  return data;
}

function messagesPayload(messages, schema, schemaName) {
  return { instructions: messages[0].content, input: messages[1].content, json_schema: schema, schema_name: schemaName };
}

export function cloudShortlistPayload(posts) {
  return messagesPayload(buildPostShortlistPrompt(posts), postShortlistSchema, POST_SHORTLIST_SCHEMA_NAME);
}

export function cloudCandidatePayload(post, preferences) {
  return messagesPayload(buildCandidateGenerationPrompt({
    post_id: post.post_id, text: post.text, context_summary: post.context_summary || "", preferences,
  }), candidateGenerationSchema, CANDIDATE_GENERATION_SCHEMA_NAME);
}

export function cloudResearchPayload(payload) {
  return { instructions: RESEARCH_WORKER_INSTRUCTIONS, input: payload, json_schema: researchResultSchema, schema_name: RESEARCH_RESULT_SCHEMA_NAME };
}

export function cloudCandidateForDedup(job) {
  const selected = job.result.selected_idea;
  const candidate = {
    candidate_id: job.id,
    source_post_id: job.source_post_id,
    target_customer: selected.payer,
    problem: selected.problem_or_opportunity,
    offer: selected.product,
    initial_price: selected.pricing_hypothesis,
    selected_idea: selected,
  };
  return { ...candidate, ...fingerprintIdea(candidate) };
}

export function vectorFromStorage(value) {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  return Array.isArray(parsed) && parsed.length && parsed.every(Number.isFinite) ? parsed : null;
}

export function selectCloudCandidates(candidates, embeddings, history, limit = PIPELINE.maxResearchCandidates) {
  if (embeddings.length !== candidates.length || embeddings.some((value) => !vectorFromStorage(value))) {
    throw new TypeError("Cloud candidate embeddings are incomplete.");
  }
  const accepted = [];
  const rejected = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const embedding = embeddings[index];
    let reason = null;
    if (history.some((idea) => idea.fingerprint_hash === candidate.fingerprint_hash)) reason = "historical_exact_duplicate";
    else if (duplicatesAcceptedIdea(candidate, embedding, accepted)) reason = "current_batch_duplicate";
    else if (history.some((idea) => isSemanticIdeaDuplicate(candidate, idea, cosineSimilarity(embedding, vectorFromStorage(idea.embedding))))) reason = "historical_semantic_duplicate";
    else if (accepted.length >= limit) reason = "outside_top_three";
    if (reason) {
      rejected.push({ candidate_id: candidate.candidate_id, source_post_id: candidate.source_post_id || candidate.source_post_ids?.[0], reason_codes: [reason] });
    } else {
      accepted.push({ ...candidate, embedding });
    }
  }
  return { accepted, rejected };
}

export function emptyCloudReport(notes, previous = {}, mode = "shadow") {
  if (!["shadow", "primary"].includes(mode)) throw new TypeError("Unsupported cloud mode.");
  return {
    assessment: { overall_evidence: "insufficient", notes }, ideas: [], sources: [], rejected: [],
    counts: {}, usage: { embeddings: { input_tokens: 0 } },
    verification: { runtime_model: "unverified", source_access: "worker_reported" },
    ...previous,
    mode, published: false, idea_ids: [],
  };
}
