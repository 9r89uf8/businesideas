const MAX_POSTS = 30;
const MAX_SOURCE_URLS = 5;

export const CONTEXT_HYDRATION_SCHEMA_NAME = "context_hydration";

export const contextHydrationSchema = {
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
          status: {
            type: "string",
            enum: ["resolved", "insufficient", "unavailable"],
          },
          context_summary: { type: "string", maxLength: 2_000 },
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
          source_urls: {
            type: "array",
            maxItems: MAX_SOURCE_URLS,
            items: { type: "string", minLength: 1, maxLength: 2_048 },
          },
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: [
          "post_id",
          "status",
          "context_summary",
          "commercial_element",
          "source_urls",
          "reason",
        ],
      },
    },
  },
  required: ["items"],
};

export default contextHydrationSchema;
