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
lang:en -is:retweet -is:quote`;

export const DEFAULT_PREFERENCES = {
  offer_bias: "software_first",
  preferred_customers: [
    "solo operators and remote workers",
    "small businesses",
    "professional service firms",
    "LATAM entrepreneurs and small businesses",
  ],
  preferred_business_models: [
    "self-serve SaaS",
    "usage-based web app",
    "transaction-fee marketplace",
    "paid data subscription",
  ],
  avoid: [
    "hardware",
    "healthcare, therapy, or medical-adjacent products",
    "consulting, agencies, audits, workshops, or custom implementation",
    "enterprise products with long sales cycles",
    "translation products",
    "generic chatbots or synthetic companions",
  ],
  personal_advantages: ["software development", "AI automation"],
};

export const IDEA_PRODUCT_ARCHETYPES = [
  "ai_cost_collapse",
  "remote_income_enablement",
  "latam_wedge",
  "ai_service_unbundling",
  "social_distribution",
  "specific_action_tool",
  "other_self_serve_ai",
];

export const IDEA_VALUE_MECHANISMS = [
  "save_time",
  "save_money",
  "make_money",
  "information_advantage",
  "distribution_advantage",
];

export const IDEA_DELIVERY_MODES = [
  "self_serve_web_app",
  "human_delivered_service",
  "custom_implementation",
  "hardware_or_offline",
];

export const IDEA_SALES_MOTIONS = [
  "self_serve_checkout",
  "online_trial_then_self_serve",
  "sales_call_required",
  "custom_contract",
];

export const IDEA_BUSINESS_MODELS = [
  "subscription",
  "usage_based",
  "transaction_fee",
  "marketplace_take_rate",
  "paid_data_access",
  "one_time_purchase",
];

export const IDEA_LATAM_FITS = ["none", "adaptable", "primary_wedge"];

export const IDEA_HARD_FILTER_CHECKS = [
  "website_deliverable",
  "self_serve_without_call",
  "solo_mvp_feasible",
  "recurring_use",
  "creates_allowed_value",
  "specific_action_not_chat",
  "no_hardware",
  "no_healthcare_therapy_or_medical",
  "no_consulting_agency_audit_or_workshop",
  "no_custom_implementation",
  "no_enterprise_sales",
  "no_translation",
  "no_generic_chat_or_companion",
];

export const POST_QUALITY = Object.freeze({
  version: "views_v4",
  minimumViews: 19_000,
  ageExponent: 0.55,
  minimumAgeHours: 2,
  maximumAgeHours: 168,
  weights: Object.freeze({
    views: 0.65,
    comments: 0.2,
    likes: 0.1,
    saves: 0.05,
  }),
});

export const PIPELINE = {
  // New runs use the scheduled cloud worker. Set to "api" for an explicit rollback.
  ideationProvider: "chatgpt_cloud",
  models: {
    extraction: "gpt-5.6-luna",
    context: "gpt-5.6-luna",
    shortlist: "gpt-5.6-sol",
    generation: "gpt-5.6-sol",
    clustering: "gpt-5.6-terra",
    research: "gpt-5.6-sol",
    embedding: "text-embedding-3-small",
  },
  reasoning: {
    extraction: "low",
    context: "low",
    shortlist: "medium",
    generation: "high",
    clustering: "medium",
    research: "high",
  },
  research: {
    schemaVersion: 2,
    promptVersion: "candidate_research_v2",
    maxToolCalls: 20,
    maxOutputTokens: 32_000,
    searchContextSize: "medium",
    pollInitialSeconds: 10,
    pollMaximumSeconds: 30,
    responseDeadlineSeconds: 1_800,
    retryDelaySeconds: 900,
    maxSources: 40,
    maxSourcesPerIdea: 10,
    maxClaimsPerIdea: 12,
    maxResultBytes: 1024 * 1024,
    leaseSeconds: 7200,
    maxAttempts: 3,
    validationRedriveSeconds: 1800,
  },
  maxCandidates: 100,
  defaultAiInputLimit: 100,
  maxForYouInput: 30,
  maxShortlistedPosts: 8,
  maxResearchCandidates: 3,
  maxSignals: 70,
  maxClusters: 8,
  maxGeneratedCandidates: 3,
  maxPublishedIdeas: 3,
  researchWindowHours: 72,
  minimumCommercialScore: 50,
  maximumHypeScore: 75,
  minimumClusterEvidence: 60,
  minimumIdeaEvidence: 65,
  minimumEvidencePosts: 3,
  minimumEvidenceAuthors: 3,
  minimumMvpBuildWeeks: 2,
  maximumMvpBuildWeeks: 6,
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
