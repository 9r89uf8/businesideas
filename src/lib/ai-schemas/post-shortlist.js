const MAX_POSTS = 30;
const MAX_ADVANCED_POSTS = 8;

export const POST_SHORTLIST_SCHEMA_NAME = "post_shortlist";

export const postShortlistSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    assessments: {
      type: "array",
      minItems: 1,
      maxItems: MAX_POSTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          post_id: {
            type: "string",
            pattern: "^[0-9]{1,32}$",
            description: "The exact X post ID supplied in the input.",
          },
          commercial_inspiration_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
          },
          what_changed: { type: "string", minLength: 1, maxLength: 1_000 },
          possible_payer: { type: "string", minLength: 1, maxLength: 500 },
          one_line_build_angle: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
          },
          decision: {
            type: "string",
            enum: ["advance", "hold", "reject"],
          },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: [
          "post_id",
          "commercial_inspiration_score",
          "what_changed",
          "possible_payer",
          "one_line_build_angle",
          "decision",
          "reason",
        ],
      },
    },
    advanced_post_ids: {
      type: "array",
      maxItems: MAX_ADVANCED_POSTS,
      items: { type: "string", pattern: "^[0-9]{1,32}$" },
    },
  },
  required: ["assessments", "advanced_post_ids"],
};

export default postShortlistSchema;
