const BUSINESS_FORMS = [
  "software",
  "managed_service",
  "marketplace",
  "infrastructure",
  "data_product",
  "consumer_website",
  "agency_enablement_product",
  "compliance_service",
  "transactional_business",
];

const nonemptyString = (maxLength) => ({
  type: "string",
  minLength: 1,
  maxLength,
});

const selectedIdea = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: nonemptyString(200),
    business_form: { type: "string", enum: BUSINESS_FORMS },
    payer: nonemptyString(500),
    user: nonemptyString(500),
    problem_or_opportunity: nonemptyString(2_000),
    product: nonemptyString(2_000),
    how_the_post_enables_it: nonemptyString(2_000),
    why_source_product_is_not_enough: nonemptyString(2_000),
    current_alternative: nonemptyString(2_000),
    payment_reason: nonemptyString(2_000),
    pricing_hypothesis: nonemptyString(500),
    distribution: nonemptyString(1_000),
    mvp: nonemptyString(2_000),
    largest_risk: nonemptyString(1_000),
    score: { type: "integer", minimum: 0, maximum: 100 },
  },
  required: [
    "title",
    "business_form",
    "payer",
    "user",
    "problem_or_opportunity",
    "product",
    "how_the_post_enables_it",
    "why_source_product_is_not_enough",
    "current_alternative",
    "payment_reason",
    "pricing_hypothesis",
    "distribution",
    "mvp",
    "largest_risk",
    "score",
  ],
};

export const CANDIDATE_GENERATION_SCHEMA_NAME = "candidate_generation";

export const candidateGenerationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["candidate", "no_viable_idea"] },
    source_post_id: {
      type: "string",
      pattern: "^[0-9]{1,32}$",
      description: "The exact X post ID supplied in the input.",
    },
    concepts_considered: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: nonemptyString(200),
          business_form: { type: "string", enum: BUSINESS_FORMS },
          summary: nonemptyString(1_000),
          payer: nonemptyString(500),
          critique: nonemptyString(1_000),
        },
        required: ["title", "business_form", "summary", "payer", "critique"],
      },
    },
    selected_idea: {
      anyOf: [selectedIdea, { type: "null" }],
    },
    reason: nonemptyString(1_000),
  },
  required: [
    "status",
    "source_post_id",
    "concepts_considered",
    "selected_idea",
    "reason",
  ],
};

export default candidateGenerationSchema;
