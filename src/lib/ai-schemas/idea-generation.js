import { PIPELINE } from "../config.js";

export const IDEA_GENERATION_SCHEMA_NAME = "idea_generation";

export const ideaGenerationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assessment: {
      type: "object",
      additionalProperties: false,
      properties: {
        overall_evidence: {
          type: "string",
          enum: ["insufficient", "weak", "moderate", "strong"],
        },
        notes: { type: "string" },
      },
      required: ["overall_evidence", "notes"],
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
          title: { type: "string" },
          target_customer: { type: "string" },
          problem: { type: "string" },
          offer: { type: "string" },
          why_pay: { type: "string" },
          why_now: { type: "string" },
          initial_price: { type: "string" },
          differentiation: { type: "string" },
          speed_to_first_revenue: { type: "string" },
          validation_plan: { type: "string" },
          risks: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
          assumptions: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
          evidence_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Strength of the supplied X evidence on the full 0-to-100 scale, never 0-to-10 or 0-to-1: 0 unsupported, 25 thin or ambiguous, 50 moderate recurring-problem support, 75 strong concrete multi-author support, and 100 exceptionally direct and consistent multi-author support. This is not model confidence or independently verified demand.",
          },
          source_post_ids: {
            type: "array",
            minItems: PIPELINE.minimumEvidencePosts,
            maxItems: 5,
            items: {
              type: "string",
              pattern: "^[0-9]+$",
            },
          },
        },
        required: [
          "rank",
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
          "risks",
          "assumptions",
          "evidence_score",
          "source_post_ids",
        ],
      },
    },
  },
  required: ["assessment", "ideas"],
};

export default ideaGenerationSchema;
