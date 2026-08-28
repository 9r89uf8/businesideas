export const DEFAULT_X_QUERY = `(
  AI OR "artificial intelligence" OR ChatGPT OR Claude
  OR Gemini OR "AI agent" OR "generative AI"
)
(
  problem OR frustrating OR broken OR manual OR workaround
  OR unreliable OR expensive OR "looking for"
  OR "need a tool" OR "wish there was" OR paying
  OR launched OR released
)
lang:en -is:retweet`;

export const DEFAULT_PREFERENCES = {
  offer_bias: "services_first",
  preferred_customers: ["small businesses", "professional service firms"],
  preferred_business_models: [
    "productized service",
    "consulting",
    "small SaaS",
  ],
  avoid: ["consumer social apps", "hardware", "regulated healthcare"],
  personal_advantages: ["software development", "AI automation"],
};

export const PIPELINE = {
  models: {
    extraction: "gpt-5.6-luna",
    clustering: "gpt-5.6-terra",
    ideation: "gpt-5.6-sol",
    embedding: "text-embedding-3-small",
  },
  reasoning: {
    extraction: "low",
    clustering: "medium",
    ideation: "high",
  },
  maxCandidates: 200,
  defaultAiInputLimit: 100,
  maxSignals: 70,
  maxClusters: 8,
  maxGeneratedCandidates: 5,
  maxPublishedIdeas: 3,
  minimumCommercialScore: 50,
  maximumHypeScore: 75,
  minimumClusterEvidence: 60,
  minimumEvidencePosts: 3,
  minimumEvidenceAuthors: 3,
  semanticDuplicateThreshold: 0.9,
};

export const IDEA_STATUSES = [
  "new",
  "saved",
  "rejected",
  "testing",
  "validated",
  "archived",
];

export const FEEDBACK_REASONS = [
  "strong_fit",
  "interesting_customer",
  "credible_problem",
  "weak_evidence",
  "market_too_crowded",
  "poor_personal_fit",
  "too_slow_to_revenue",
  "too_difficult",
  "pricing_unrealistic",
  "already_considered",
  "other",
];
