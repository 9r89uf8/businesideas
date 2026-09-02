import {
  IDEA_BUSINESS_MODELS,
  IDEA_DELIVERY_MODES,
  IDEA_HARD_FILTER_CHECKS,
  IDEA_LATAM_FITS,
  IDEA_PRODUCT_ARCHETYPES,
  IDEA_SALES_MOTIONS,
  IDEA_VALUE_MECHANISMS,
  PIPELINE,
} from "../config.js";

export const RESEARCH_SOURCE_TYPES = [
  "competitor",
  "competitor_pricing",
  "customer_evidence",
  "feasibility",
  "distribution",
  "latam_fit",
  "risk",
  "other",
];

export const RESEARCH_RESULT_SCHEMA_NAME = "research_result";
export const IDEA_GENERATION_SCHEMA_NAME = RESEARCH_RESULT_SCHEMA_NAME;

const nonemptyString = (maxLength) => ({
  type: "string",
  minLength: 1,
  maxLength,
});

const researchSourceId = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
};

const productSpec = {
  type: "object",
  additionalProperties: false,
  properties: {
    archetype: { type: "string", enum: IDEA_PRODUCT_ARCHETYPES },
    core_action: nonemptyString(1_000),
    value_mechanisms: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { type: "string", enum: IDEA_VALUE_MECHANISMS },
    },
    delivery_mode: { type: "string", enum: IDEA_DELIVERY_MODES },
    sales_motion: { type: "string", enum: IDEA_SALES_MOTIONS },
    business_model: { type: "string", enum: IDEA_BUSINESS_MODELS },
    mvp_scope: nonemptyString(2_000),
    mvp_build_weeks: {
      type: "integer",
      minimum: 1,
      maximum: 52,
      description: `Honest solo-developer estimate; publication requires ${PIPELINE.minimumMvpBuildWeeks} to ${PIPELINE.maximumMvpBuildWeeks} weeks.`,
    },
    recurring_trigger: nonemptyString(1_000),
    latam_fit: { type: "string", enum: IDEA_LATAM_FITS },
    latam_rationale: nonemptyString(1_000),
  },
  required: [
    "archetype",
    "core_action",
    "value_mechanisms",
    "delivery_mode",
    "sales_motion",
    "business_model",
    "mvp_scope",
    "mvp_build_weeks",
    "recurring_trigger",
    "latam_fit",
    "latam_rationale",
  ],
};

const hardFilterChecks = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    IDEA_HARD_FILTER_CHECKS.map((name) => [name, { type: "boolean" }]),
  ),
  required: IDEA_HARD_FILTER_CHECKS,
};

export const researchResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: {
      type: "integer",
      enum: [PIPELINE.research.schemaVersion],
    },
    assessment: {
      type: "object",
      additionalProperties: false,
      properties: {
        overall_evidence: {
          type: "string",
          enum: ["insufficient", "weak", "moderate", "strong"],
        },
        notes: { type: "string", maxLength: 4_000 },
      },
      required: ["overall_evidence", "notes"],
    },
    sources: {
      type: "array",
      maxItems: PIPELINE.research.maxSources,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_id: researchSourceId,
          url: nonemptyString(2_048),
          title: nonemptyString(500),
          publisher: {
            type: ["string", "null"],
            minLength: 1,
            maxLength: 300,
          },
          published_at: { type: ["string", "null"], maxLength: 64 },
          accessed_at: nonemptyString(64),
          source_type: { type: "string", enum: RESEARCH_SOURCE_TYPES },
          supported_claims: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            uniqueItems: true,
            items: nonemptyString(1_000),
          },
        },
        required: [
          "source_id",
          "url",
          "title",
          "publisher",
          "published_at",
          "accessed_at",
          "source_type",
          "supported_claims",
        ],
      },
    },
    ideas: {
      type: "array",
      maxItems: PIPELINE.maxGeneratedCandidates,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          rank: {
            type: "integer",
            minimum: 1,
            maximum: PIPELINE.maxGeneratedCandidates,
          },
          candidate_id: {
            type: "string",
            minLength: 1,
            maxLength: 64,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
            description:
              "The exact candidate_id supplied in the immutable research payload.",
          },
          title: nonemptyString(200),
          target_customer: nonemptyString(500),
          problem: nonemptyString(2_000),
          offer: nonemptyString(2_000),
          why_pay: nonemptyString(2_000),
          why_now: nonemptyString(2_000),
          initial_price: nonemptyString(500),
          differentiation: nonemptyString(2_000),
          speed_to_first_revenue: nonemptyString(1_000),
          validation_plan: nonemptyString(2_000),
          product_spec: productSpec,
          hard_filter_checks: hardFilterChecks,
          risks: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: nonemptyString(1_000),
          },
          assumptions: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: nonemptyString(1_000),
          },
          evidence_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Strength of the candidate's one supplied X post only on the full 0-to-100 scale, never 0-to-10 or 0-to-1: 0 unsupported, 25 thin or ambiguous, 50 moderate but concrete commercial signal, 75 strong payer/value signal, and 100 exceptionally direct purchase or spending evidence. This is not model confidence, and external research must not increase it.",
          },
          source_post_ids: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            uniqueItems: true,
            items: {
              type: "string",
              maxLength: 32,
              pattern: "^[0-9]+$",
            },
          },
          research_source_ids: {
            type: "array",
            minItems: 1,
            maxItems: PIPELINE.research.maxSourcesPerIdea,
            uniqueItems: true,
            items: researchSourceId,
          },
          claim_source_map: {
            type: "array",
            minItems: 1,
            maxItems: PIPELINE.research.maxClaimsPerIdea,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                claim: nonemptyString(1_000),
                research_source_ids: {
                  type: "array",
                  minItems: 1,
                  maxItems: PIPELINE.research.maxSourcesPerIdea,
                  uniqueItems: true,
                  items: researchSourceId,
                },
              },
              required: ["claim", "research_source_ids"],
            },
          },
        },
        required: [
          "rank",
          "candidate_id",
          "title",
          "target_customer",
          "problem",
          "offer",
          "why_pay",
          "why_now",
          "initial_price",
          "differentiation",
          "speed_to_first_revenue",
          "validation_plan",
          "product_spec",
          "hard_filter_checks",
          "risks",
          "assumptions",
          "evidence_score",
          "source_post_ids",
          "research_source_ids",
          "claim_source_map",
        ],
      },
    },
  },
  required: ["schema_version", "assessment", "sources", "ideas"],
};

export const ideaGenerationSchema = researchResultSchema;
export default researchResultSchema;
