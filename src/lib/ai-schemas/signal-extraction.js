import { PIPELINE } from "../config.js";

export const SIGNAL_EXTRACTION_SCHEMA_NAME = "signal_extraction";

export const signalExtractionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      maxItems: PIPELINE.defaultAiInputLimit,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          post_id: {
            type: "string",
            pattern: "^[0-9]+$",
            description: "The exact X post ID supplied in the input.",
          },
          relevant: {
            type: "boolean",
            description: "Whether the post contains a useful commercial signal.",
          },
          signal_type: {
            type: "string",
            enum: [
              "pain",
              "request",
              "workaround",
              "spending",
              "new_capability",
              "hype",
              "none",
            ],
          },
          target_customer: {
            type: "string",
            description:
              "The supported customer group, or an empty string when absent.",
          },
          problem: {
            type: "string",
            description:
              "The concrete job or operational problem, or an empty string.",
          },
          evidence_excerpt: {
            type: "string",
            description:
              "An exact substring of the post, or an empty string when unavailable.",
          },
          summary: {
            type: "string",
            description:
              "A concise paraphrase of the commercial signal, or an empty string.",
          },
          commercial_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Commercial relevance on the full 0-to-100 scale; 50 is the minimum clear actionable need.",
          },
          hype_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Hype intensity on the full 0-to-100 scale; 75 means mostly hype or launch commentary.",
          },
        },
        required: [
          "post_id",
          "relevant",
          "signal_type",
          "target_customer",
          "problem",
          "evidence_excerpt",
          "summary",
          "commercial_score",
          "hype_score",
        ],
      },
    },
  },
  required: ["items"],
};

export default signalExtractionSchema;
