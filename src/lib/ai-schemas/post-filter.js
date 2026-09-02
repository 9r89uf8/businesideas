const MAX_POSTS = 30;

export const POST_FILTER_SCHEMA_NAME = "post_filter";

export const postFilterSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
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
          decision: {
            type: "string",
            enum: ["keep", "reject", "needs_context"],
          },
          reason: { type: "string", minLength: 1, maxLength: 500 },
          commercial_element: {
            type: "string",
            enum: [
              "capability",
              "problem",
              "request",
              "result",
              "spending",
              "change",
              "none",
            ],
          },
        },
        required: ["post_id", "decision", "reason", "commercial_element"],
      },
    },
  },
  required: ["items"],
};

export default postFilterSchema;
