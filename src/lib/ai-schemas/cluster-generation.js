import { PIPELINE } from "../config.js";

export const CLUSTER_GENERATION_SCHEMA_NAME = "cluster_generation";

export const clusterGenerationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    clusters: {
      type: "array",
      maxItems: PIPELINE.maxClusters,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          target_customer: { type: "string" },
          problem: { type: "string" },
          why_now: { type: "string" },
          summary: { type: "string" },
          evidence_post_ids: {
            type: "array",
            minItems: PIPELINE.minimumEvidencePosts,
            maxItems: PIPELINE.maxSignals,
            items: {
              type: "string",
              pattern: "^[0-9]+$",
            },
          },
          evidence_strength: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Evidence strength on the full 0-to-100 scale; 60 is the minimum sufficiently supported cluster for ideation.",
          },
          payment_signal: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description:
              "Payment evidence on the full 0-to-100 scale; 50 indicates credible budget, costly-workaround, or purchase context.",
          },
        },
        required: [
          "title",
          "target_customer",
          "problem",
          "why_now",
          "summary",
          "evidence_post_ids",
          "evidence_strength",
          "payment_signal",
        ],
      },
    },
  },
  required: ["clusters"],
};

export default clusterGenerationSchema;
