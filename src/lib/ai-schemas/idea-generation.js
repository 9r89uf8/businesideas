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
          product_spec: {
            type: "object",
            additionalProperties: false,
            properties: {
              archetype: {
                type: "string",
                enum: IDEA_PRODUCT_ARCHETYPES,
                description:
                  "Best-fit soft archetype. This is a classification, never a quota.",
              },
              core_action: {
                type: "string",
                description:
                  "The specific action the website performs and concrete outcome it produces; not a generic conversation.",
              },
              value_mechanisms: {
                type: "array",
                minItems: 1,
                maxItems: 3,
                items: { type: "string", enum: IDEA_VALUE_MECHANISMS },
              },
              delivery_mode: {
                type: "string",
                enum: IDEA_DELIVERY_MODES,
              },
              sales_motion: {
                type: "string",
                enum: IDEA_SALES_MOTIONS,
              },
              business_model: {
                type: "string",
                enum: IDEA_BUSINESS_MODELS,
              },
              mvp_scope: {
                type: "string",
                description:
                  "A narrow description of what the first build includes and excludes.",
              },
              mvp_build_weeks: {
                type: "integer",
                minimum: 1,
                maximum: 52,
                description: `Honest solo-developer MVP estimate. Publication requires ${PIPELINE.minimumMvpBuildWeeks} to ${PIPELINE.maximumMvpBuildWeeks} weeks.`,
              },
              recurring_trigger: {
                type: "string",
                description:
                  "A concrete event or workflow that repeatedly causes the customer to return.",
              },
              latam_fit: {
                type: "string",
                enum: IDEA_LATAM_FITS,
                description:
                  "A soft market/design fit classification, not evidence unless supplied posts explicitly support it.",
              },
              latam_rationale: {
                type: "string",
                description:
                  "Why LATAM is or is not a plausible wedge without relying on translation as the product.",
              },
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
          },
          hard_filter_checks: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
              IDEA_HARD_FILTER_CHECKS.map((name) => [
                name,
                {
                  type: "boolean",
                  description:
                    "True only when the candidate itself satisfies this hard publication rule.",
                },
              ]),
            ),
            required: IDEA_HARD_FILTER_CHECKS,
          },
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
          "product_spec",
          "hard_filter_checks",
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
