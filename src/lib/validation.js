import {
  IDEA_BUSINESS_MODELS,
  IDEA_DELIVERY_MODES,
  IDEA_HARD_FILTER_CHECKS,
  IDEA_LATAM_FITS,
  IDEA_PRODUCT_ARCHETYPES,
  IDEA_SALES_MOTIONS,
  IDEA_VALUE_MECHANISMS,
  PIPELINE,
} from "./config.js";
import { RESEARCH_SOURCE_TYPES } from "./ai-schemas/idea-generation.js";
import { normalizePublicResearchUrl } from "./research/public-url.js";

const SIGNAL_TYPES = new Set([
  "pain",
  "request",
  "workaround",
  "spending",
  "new_capability",
  "hype",
  "none",
]);

const QUALIFYING_SIGNAL_TYPES = new Set([
  "pain",
  "request",
  "workaround",
  "spending",
]);

const OVERALL_EVIDENCE_VALUES = new Set([
  "insufficient",
  "weak",
  "moderate",
  "strong",
]);
const PUBLISHABLE_OVERALL_EVIDENCE = new Set(["moderate", "strong"]);
const PRODUCT_ARCHETYPES = new Set(IDEA_PRODUCT_ARCHETYPES);
const VALUE_MECHANISMS = new Set(IDEA_VALUE_MECHANISMS);
const DELIVERY_MODES = new Set(IDEA_DELIVERY_MODES);
const SALES_MOTIONS = new Set(IDEA_SALES_MOTIONS);
const BUSINESS_MODELS = new Set(IDEA_BUSINESS_MODELS);
const LATAM_FITS = new Set(IDEA_LATAM_FITS);
const PUBLISHABLE_SALES_MOTIONS = new Set([
  "self_serve_checkout",
  "online_trial_then_self_serve",
]);

const REQUIRED_IDEA_FIELDS = [
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
];

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function recordId(record) {
  const value = record?.post_id ?? record?.id ?? record?.x_post_id;
  return isNonEmptyString(value) ? value.trim() : null;
}

function authorId(record) {
  const value =
    record?.author_id ??
    record?.authorId ??
    record?.post?.author_id ??
    record?.posts?.author_id;
  return isNonEmptyString(value) ? value.trim() : null;
}

function expectArray(response, key, label) {
  if (!response || typeof response !== "object" || !Array.isArray(response[key])) {
    throw new TypeError(`${label} response must contain a ${key} array`);
  }

  return response[key];
}

function createRecordMap(records, label) {
  if (!Array.isArray(records)) {
    throw new TypeError(`${label} must be an array`);
  }

  const map = new Map();

  records.forEach((record) => {
    const id = recordId(record);

    if (!id) {
      throw new TypeError(`Every ${label} entry must have a string post ID`);
    }

    if (map.has(id)) {
      throw new TypeError(`${label} contains duplicate post ID ${id}`);
    }

    map.set(id, record);
  });

  return map;
}

function normalizeIdCollection(values) {
  if (values instanceof Set) {
    return new Set([...values].filter(isNonEmptyString).map((value) => value.trim()));
  }

  if (!Array.isArray(values)) {
    return null;
  }

  const ids = values
    .map((value) => (typeof value === "string" ? value : recordId(value)))
    .filter(isNonEmptyString)
    .map((value) => value.trim());

  return new Set(ids);
}

function uniqueIds(values) {
  if (!Array.isArray(values) || values.some((value) => !isNonEmptyString(value))) {
    return null;
  }

  return [...new Set(values.map((value) => value.trim()))];
}

function cleanStringArray(values) {
  if (!Array.isArray(values) || values.some((value) => !isNonEmptyString(value))) {
    return null;
  }

  return values.map((value) => value.trim());
}

function validProductSpec(productSpec) {
  if (!productSpec || typeof productSpec !== "object") {
    return false;
  }

  const valueMechanisms = cleanStringArray(productSpec.value_mechanisms);

  return (
    PRODUCT_ARCHETYPES.has(productSpec.archetype) &&
    isNonEmptyString(productSpec.core_action) &&
    valueMechanisms !== null &&
    valueMechanisms.length >= 1 &&
    valueMechanisms.length <= 3 &&
    new Set(valueMechanisms).size === valueMechanisms.length &&
    valueMechanisms.every((value) => VALUE_MECHANISMS.has(value)) &&
    DELIVERY_MODES.has(productSpec.delivery_mode) &&
    SALES_MOTIONS.has(productSpec.sales_motion) &&
    BUSINESS_MODELS.has(productSpec.business_model) &&
    isNonEmptyString(productSpec.mvp_scope) &&
    Number.isInteger(productSpec.mvp_build_weeks) &&
    productSpec.mvp_build_weeks > 0 &&
    isNonEmptyString(productSpec.recurring_trigger) &&
    LATAM_FITS.has(productSpec.latam_fit) &&
    isNonEmptyString(productSpec.latam_rationale)
  );
}

function validHardFilterChecks(checks) {
  return (
    checks &&
    typeof checks === "object" &&
    IDEA_HARD_FILTER_CHECKS.every(
      (name) => typeof checks[name] === "boolean",
    )
  );
}

function cleanProductSpec(productSpec) {
  return {
    archetype: productSpec.archetype,
    core_action: productSpec.core_action.trim(),
    value_mechanisms: productSpec.value_mechanisms.map((value) => value.trim()),
    delivery_mode: productSpec.delivery_mode,
    sales_motion: productSpec.sales_motion,
    business_model: productSpec.business_model,
    mvp_scope: productSpec.mvp_scope.trim(),
    mvp_build_weeks: productSpec.mvp_build_weeks,
    recurring_trigger: productSpec.recurring_trigger.trim(),
    latam_fit: productSpec.latam_fit,
    latam_rationale: productSpec.latam_rationale.trim(),
  };
}

function missingLunaItem(postId) {
  return {
    post_id: postId,
    relevant: false,
    signal_type: "none",
    target_customer: "",
    problem: "",
    evidence_excerpt: "",
    summary: "",
    commercial_score: 0,
    hype_score: 0,
  };
}

function validLunaItem(item) {
  return (
    item &&
    typeof item === "object" &&
    typeof item.relevant === "boolean" &&
    SIGNAL_TYPES.has(item.signal_type) &&
    isScore(item.commercial_score) &&
    isScore(item.hype_score)
  );
}

function compareClusters(left, right) {
  return (
    right.evidence_strength - left.evidence_strength ||
    right.payment_signal - left.payment_signal ||
    right.evidence_post_ids.length - left.evidence_post_ids.length ||
    left.title.localeCompare(right.title)
  );
}

function compareIdeas(left, right) {
  return (
    left.rank - right.rank ||
    right.evidence_score - left.evidence_score ||
    left.title.localeCompare(right.title)
  );
}

export function validateExactExcerpt(excerpt, originalText) {
  return (
    typeof excerpt === "string" &&
    excerpt.length > 0 &&
    typeof originalText === "string" &&
    originalText.includes(excerpt)
  );
}

/**
 * Returns one item for each supplied post, in input order. Unknown, duplicate,
 * missing, or invalid model entries become the standard irrelevant item.
 */
export function validateLunaResponse(response, posts) {
  const responseItems = expectArray(response, "items", "Luna");
  const postsById = createRecordMap(posts, "posts");
  const occurrenceCounts = new Map();

  for (const item of responseItems) {
    const id = recordId(item);

    if (id) {
      occurrenceCounts.set(id, (occurrenceCounts.get(id) ?? 0) + 1);
    }
  }

  const modelItemsById = new Map();

  for (const item of responseItems) {
    const id = recordId(item);

    if (
      !id ||
      !postsById.has(id) ||
      occurrenceCounts.get(id) !== 1 ||
      !validLunaItem(item)
    ) {
      continue;
    }

    const post = postsById.get(id);
    const excerpt = validateExactExcerpt(item.evidence_excerpt, post.text)
      ? item.evidence_excerpt
      : "";

    modelItemsById.set(id, {
      post_id: id,
      relevant: item.relevant,
      signal_type: item.signal_type,
      target_customer: cleanString(item.target_customer),
      problem: cleanString(item.problem),
      evidence_excerpt: excerpt,
      summary: cleanString(item.summary),
      commercial_score: item.commercial_score,
      hype_score: item.hype_score,
    });
  }

  return {
    items: [...postsById.keys()].map(
      (id) => modelItemsById.get(id) ?? missingLunaItem(id),
    ),
  };
}

/**
 * `clusters` contains every structurally and source-valid Terra cluster.
 * `eligibleClusters` contains at most eight clusters passing section 7.3.
 */
export function validateTerraResponse(
  response,
  signals,
  {
    runPostIds,
    minimumEvidencePosts = PIPELINE.minimumEvidencePosts,
    minimumEvidenceAuthors = PIPELINE.minimumEvidenceAuthors,
    minimumEvidenceStrength = PIPELINE.minimumClusterEvidence,
    maxClusters = PIPELINE.maxClusters,
  } = {},
) {
  const responseClusters = expectArray(response, "clusters", "Terra");
  const signalsById = createRecordMap(signals, "signals");
  const approvedSignals = new Map(
    [...signalsById].filter(([, signal]) => signal?.relevant === true),
  );
  const explicitRunIds = normalizeIdCollection(runPostIds);
  const currentRunIds = explicitRunIds ?? new Set(signalsById.keys());
  const clusters = [];

  for (const cluster of responseClusters) {
    if (
      !cluster ||
      typeof cluster !== "object" ||
      !isNonEmptyString(cluster.title) ||
      !isNonEmptyString(cluster.target_customer) ||
      !isNonEmptyString(cluster.problem) ||
      !isNonEmptyString(cluster.summary) ||
      !isScore(cluster.evidence_strength) ||
      !isScore(cluster.payment_signal)
    ) {
      continue;
    }

    const sourceIds = uniqueIds(cluster.evidence_post_ids);

    if (
      sourceIds === null ||
      sourceIds.some(
        (id) => !approvedSignals.has(id) || !currentRunIds.has(id),
      )
    ) {
      continue;
    }

    const sourceSignals = sourceIds.map((id) => approvedSignals.get(id));
    const independentAuthorCount = new Set(
      sourceSignals.map(authorId).filter(Boolean),
    ).size;
    const hasQualifyingSignal = sourceSignals.some((signal) =>
      QUALIFYING_SIGNAL_TYPES.has(signal.signal_type),
    );
    const hypeCount = sourceSignals.filter(
      (signal) => signal.signal_type === "hype",
    ).length;
    const primarilyCommentary =
      sourceSignals.length > 0 && hypeCount > sourceSignals.length / 2;
    const eligibilityReasons = [];

    if (sourceIds.length < minimumEvidencePosts) {
      eligibilityReasons.push("insufficient_posts");
    }

    if (independentAuthorCount < minimumEvidenceAuthors) {
      eligibilityReasons.push("insufficient_authors");
    }

    if (!hasQualifyingSignal) {
      eligibilityReasons.push("no_qualifying_signal");
    }

    if (cluster.evidence_strength < minimumEvidenceStrength) {
      eligibilityReasons.push("weak_evidence");
    }

    if (primarilyCommentary) {
      eligibilityReasons.push("primarily_commentary");
    }

    clusters.push({
      ...cluster,
      title: cluster.title.trim(),
      target_customer: cluster.target_customer.trim(),
      problem: cluster.problem.trim(),
      why_now: cleanString(cluster.why_now),
      summary: cluster.summary.trim(),
      evidence_post_ids: sourceIds,
      eligible: eligibilityReasons.length === 0,
      independent_author_count: independentAuthorCount,
      eligibility_reasons: eligibilityReasons,
    });
  }

  const effectiveMaxClusters =
    Number.isInteger(maxClusters) && maxClusters >= 0 ? maxClusters : 0;
  const eligibleClusters = clusters
    .filter((cluster) => cluster.eligible)
    .sort(compareClusters)
    .slice(0, effectiveMaxClusters);
  const retainedClusters = new Set(eligibleClusters);

  for (const cluster of clusters) {
    if (cluster.eligible && !retainedClusters.has(cluster)) {
      cluster.eligible = false;
      cluster.eligibility_reasons.push("cluster_limit");
    }
  }

  return { clusters, eligibleClusters };
}

function structurallyValidIdea(idea) {
  if (
    !idea ||
    typeof idea !== "object" ||
    !Number.isInteger(idea.rank) ||
    idea.rank < 1 ||
    !isScore(idea.evidence_score) ||
    !validProductSpec(idea.product_spec) ||
    !validHardFilterChecks(idea.hard_filter_checks) ||
    REQUIRED_IDEA_FIELDS.some((key) => !isNonEmptyString(idea[key]))
  ) {
    return false;
  }

  const risks = cleanStringArray(idea.risks);
  const assumptions = cleanStringArray(idea.assumptions);

  return risks !== null && risks.length > 0 && assumptions !== null && assumptions.length > 0;
}

/**
 * `ideas` contains structurally valid candidates whose IDs are fully grounded
 * in the supplied clusters and current run. `publishableIdeas` additionally
 * meets the evidence, self-serve product, MVP, and hard-filter gates and is
 * capped at three.
 */
function validateLegacyIdeaResponse(
  response,
  clusters,
  runPosts,
  {
    minimumEvidencePosts = PIPELINE.minimumEvidencePosts,
    minimumEvidenceAuthors = PIPELINE.minimumEvidenceAuthors,
    maxGeneratedCandidates = PIPELINE.maxGeneratedCandidates,
    maxPublishedIdeas = PIPELINE.maxPublishedIdeas,
  } = {},
) {
  const responseIdeas = expectArray(response, "ideas", "Sol");

  if (
    !response.assessment ||
    typeof response.assessment !== "object" ||
    !OVERALL_EVIDENCE_VALUES.has(response.assessment.overall_evidence) ||
    typeof response.assessment.notes !== "string"
  ) {
    throw new TypeError("Sol response must contain a valid assessment");
  }

  if (!Array.isArray(clusters)) {
    throw new TypeError("clusters must be an array");
  }

  const postsById = createRecordMap(runPosts, "runPosts");
  const clusterSourceIds = new Set();

  for (const cluster of clusters) {
    const ids = uniqueIds(cluster?.evidence_post_ids);

    if (ids === null) {
      throw new TypeError("Every supplied cluster must have string evidence IDs");
    }

    ids.forEach((id) => clusterSourceIds.add(id));
  }

  const ideas = [];

  for (const idea of responseIdeas) {
    if (!structurallyValidIdea(idea)) {
      continue;
    }

    const sourceIds = uniqueIds(idea.source_post_ids);

    if (
      sourceIds === null ||
      sourceIds.some(
        (id) => !postsById.has(id) || !clusterSourceIds.has(id),
      )
    ) {
      continue;
    }

    const independentAuthorCount = new Set(
      sourceIds.map((id) => authorId(postsById.get(id))).filter(Boolean),
    ).size;
    const validationErrors = [];

    if (sourceIds.length < minimumEvidencePosts) {
      validationErrors.push("insufficient_posts");
    }

    if (independentAuthorCount < minimumEvidenceAuthors) {
      validationErrors.push("insufficient_authors");
    }

    if (
      !PUBLISHABLE_OVERALL_EVIDENCE.has(
        response.assessment.overall_evidence,
      )
    ) {
      validationErrors.push("weak_overall_evidence");
    }

    if (idea.evidence_score < PIPELINE.minimumIdeaEvidence) {
      validationErrors.push("weak_idea_evidence");
    }

    if (idea.product_spec.delivery_mode !== "self_serve_web_app") {
      validationErrors.push("not_self_serve_web_app");
    }

    if (!PUBLISHABLE_SALES_MOTIONS.has(idea.product_spec.sales_motion)) {
      validationErrors.push("requires_sales_process");
    }

    if (
      idea.product_spec.mvp_build_weeks < PIPELINE.minimumMvpBuildWeeks ||
      idea.product_spec.mvp_build_weeks > PIPELINE.maximumMvpBuildWeeks
    ) {
      validationErrors.push("mvp_outside_2_to_6_weeks");
    }

    for (const check of IDEA_HARD_FILTER_CHECKS) {
      if (!idea.hard_filter_checks[check]) {
        validationErrors.push(`hard_filter_failed:${check}`);
      }
    }

    ideas.push({
      ...idea,
      ...Object.fromEntries(
        REQUIRED_IDEA_FIELDS.map((key) => [key, idea[key].trim()]),
      ),
      risks: idea.risks.map((risk) => risk.trim()),
      assumptions: idea.assumptions.map((assumption) => assumption.trim()),
      product_spec: cleanProductSpec(idea.product_spec),
      hard_filter_checks: Object.fromEntries(
        IDEA_HARD_FILTER_CHECKS.map((name) => [
          name,
          idea.hard_filter_checks[name],
        ]),
      ),
      source_post_ids: sourceIds,
      independent_author_count: independentAuthorCount,
      publishable: validationErrors.length === 0,
      validation_errors: validationErrors,
    });
  }

  const effectiveMaxGenerated =
    Number.isInteger(maxGeneratedCandidates) && maxGeneratedCandidates >= 0
      ? maxGeneratedCandidates
      : 0;
  const effectiveMaxPublished =
    Number.isInteger(maxPublishedIdeas) && maxPublishedIdeas >= 0
      ? maxPublishedIdeas
      : 0;
  const rankedIdeas = ideas.sort(compareIdeas).slice(0, effectiveMaxGenerated);
  const publishableIdeas = rankedIdeas
    .filter((idea) => idea.publishable)
    .slice(0, effectiveMaxPublished);

  return {
    assessment: {
      overall_evidence: response.assessment.overall_evidence.trim(),
      notes: response.assessment.notes.trim(),
    },
    ideas: rankedIdeas,
    publishableIdeas,
  };
}

const RESEARCH_SOURCE_TYPE_SET = new Set(RESEARCH_SOURCE_TYPES);
const RESEARCH_SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PRODUCT_SPEC_KEYS = [
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
];
const RESEARCH_RESULT_KEYS = ["schema_version", "assessment", "sources", "ideas"];
const RESEARCH_ASSESSMENT_KEYS = ["overall_evidence", "notes"];
const RESEARCH_SOURCE_KEYS = [
  "source_id",
  "url",
  "title",
  "publisher",
  "published_at",
  "accessed_at",
  "source_type",
  "supported_claims",
];
const RESEARCH_IDEA_KEYS = [
  "rank",
  "cluster_id",
  ...REQUIRED_IDEA_FIELDS,
  "product_spec",
  "hard_filter_checks",
  "risks",
  "assumptions",
  "evidence_score",
  "source_post_ids",
  "research_source_ids",
  "claim_source_map",
];
const CLAIM_SOURCE_MAP_KEYS = ["claim", "research_source_ids"];

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedString(value, maximum, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum) return null;
  const normalized = value.trim();
  return normalized || (allowEmpty ? "" : null);
}

function boundedStringArray(values, { minimum, maximum, stringMaximum }) {
  if (
    !Array.isArray(values) ||
    values.length < minimum ||
    values.length > maximum
  ) {
    return null;
  }

  const normalized = values.map((value) => boundedString(value, stringMaximum));
  if (normalized.some((value) => value === null)) return null;
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function normalizeResearchSourceIds(values, { minimum = 1 } = {}) {
  if (
    !Array.isArray(values) ||
    values.length < minimum ||
    values.length > PIPELINE.research.maxSourcesPerIdea
  ) {
    return null;
  }

  const normalized = values.map((value) =>
    typeof value === "string" ? value.trim() : "",
  );
  if (
    normalized.some((value) => !RESEARCH_SOURCE_ID_PATTERN.test(value)) ||
    new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return normalized;
}

function normalizeResearchPostIds(values) {
  if (
    !Array.isArray(values) ||
    values.length < PIPELINE.minimumEvidencePosts ||
    values.length > 5
  ) {
    return null;
  }
  const normalized = values.map((value) =>
    typeof value === "string" ? value.trim() : "",
  );
  if (
    normalized.some((value) => !/^\d{1,32}$/.test(value)) ||
    new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return normalized;
}

function normalizeTimestamp(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === "")) return null;
  if (typeof value !== "string" || value.length > 64) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function normalizeResearchSource(source) {
  if (!hasExactKeys(source, RESEARCH_SOURCE_KEYS)) return null;
  const sourceId = boundedString(source.source_id, 64);
  const url = normalizePublicResearchUrl(source.url);
  const title = boundedString(source.title, 500);
  const publisher =
    source.publisher === null ? null : boundedString(source.publisher, 300);
  const publishedAt = normalizeTimestamp(source.published_at, { nullable: true });
  const accessedAt = normalizeTimestamp(source.accessed_at);
  const claims = boundedStringArray(source.supported_claims, {
    minimum: 1,
    maximum: 20,
    stringMaximum: 1_000,
  });

  if (
    !sourceId ||
    !RESEARCH_SOURCE_ID_PATTERN.test(sourceId) ||
    !url ||
    !title ||
    (publisher === null && source.publisher !== null) ||
    publishedAt === undefined ||
    accessedAt === undefined ||
    !RESEARCH_SOURCE_TYPE_SET.has(source.source_type) ||
    !claims
  ) {
    return null;
  }

  return {
    source_id: sourceId,
    url,
    title,
    publisher,
    published_at: publishedAt,
    accessed_at: accessedAt,
    source_type: source.source_type,
    supported_claims: claims,
  };
}

function normalizeClaimSourceMap(value) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > PIPELINE.research.maxClaimsPerIdea
  ) {
    return null;
  }

  const normalized = [];
  const seenClaims = new Set();
  for (const mapping of value) {
    if (!hasExactKeys(mapping, CLAIM_SOURCE_MAP_KEYS)) return null;
    const claim = boundedString(mapping.claim, 1_000);
    const researchSourceIds = normalizeResearchSourceIds(
      mapping.research_source_ids,
    );
    if (!claim || !researchSourceIds || seenClaims.has(claim)) return null;
    seenClaims.add(claim);
    normalized.push({ claim, research_source_ids: researchSourceIds });
  }
  return normalized;
}

function normalizeStrictResearchIdea(idea) {
  if (
    !hasExactKeys(idea, RESEARCH_IDEA_KEYS) ||
    !hasExactKeys(idea.product_spec, PRODUCT_SPEC_KEYS) ||
    !hasExactKeys(idea.hard_filter_checks, IDEA_HARD_FILTER_CHECKS) ||
    !Number.isInteger(idea.rank) ||
    idea.rank < 1 ||
    idea.rank > PIPELINE.maxGeneratedCandidates ||
    !isScore(idea.evidence_score)
  ) {
    return null;
  }

  const fields = Object.fromEntries(
    REQUIRED_IDEA_FIELDS.map((key) => [
      key,
      boundedString(
        idea[key],
        key === "title"
          ? 200
          : ["target_customer", "initial_price"].includes(key)
            ? 500
            : key === "speed_to_first_revenue"
              ? 1_000
              : 2_000,
      ),
    ]),
  );
  const clusterId = boundedString(idea.cluster_id, 64);
  const risks = boundedStringArray(idea.risks, {
    minimum: 1,
    maximum: 5,
    stringMaximum: 1_000,
  });
  const assumptions = boundedStringArray(idea.assumptions, {
    minimum: 1,
    maximum: 5,
    stringMaximum: 1_000,
  });
  const sourcePostIds = normalizeResearchPostIds(idea.source_post_ids);
  const researchSourceIds = normalizeResearchSourceIds(
    idea.research_source_ids,
  );
  const claimSourceMap = normalizeClaimSourceMap(idea.claim_source_map);

  if (
    Object.values(fields).some((value) => value === null) ||
    !clusterId ||
    !risks ||
    !assumptions ||
    sourcePostIds === null ||
    !researchSourceIds ||
    !claimSourceMap ||
    !validProductSpec(idea.product_spec) ||
    idea.product_spec.mvp_build_weeks > 52 ||
    !validHardFilterChecks(idea.hard_filter_checks) ||
    boundedString(idea.product_spec.core_action, 1_000) === null ||
    boundedString(idea.product_spec.mvp_scope, 2_000) === null ||
    boundedString(idea.product_spec.recurring_trigger, 1_000) === null ||
    boundedString(idea.product_spec.latam_rationale, 1_000) === null
  ) {
    return null;
  }

  return {
    ...idea,
    ...fields,
    cluster_id: clusterId,
    risks,
    assumptions,
    product_spec: cleanProductSpec(idea.product_spec),
    hard_filter_checks: Object.fromEntries(
      IDEA_HARD_FILTER_CHECKS.map((name) => [
        name,
        idea.hard_filter_checks[name],
      ]),
    ),
    source_post_ids: sourcePostIds,
    research_source_ids: researchSourceIds,
    claim_source_map: claimSourceMap,
  };
}

export function validateResearchResultShape(response) {
  let encodedSize;
  try {
    encodedSize = new TextEncoder().encode(JSON.stringify(response)).byteLength;
  } catch {
    throw new TypeError("Research result must be serializable JSON.");
  }

  if (encodedSize > PIPELINE.research.maxResultBytes) {
    throw new RangeError("Research result exceeds the maximum allowed size.");
  }
  if (!hasExactKeys(response, RESEARCH_RESULT_KEYS)) {
    throw new TypeError("Research result has an invalid root object.");
  }
  if (response.schema_version !== PIPELINE.research.schemaVersion) {
    throw new TypeError("Research result uses an unsupported schema version.");
  }
  if (
    !hasExactKeys(response.assessment, RESEARCH_ASSESSMENT_KEYS) ||
    !OVERALL_EVIDENCE_VALUES.has(response.assessment.overall_evidence) ||
    boundedString(response.assessment.notes, 4_000, { allowEmpty: true }) === null
  ) {
    throw new TypeError("Research result has an invalid assessment.");
  }
  if (
    !Array.isArray(response.sources) ||
    response.sources.length > PIPELINE.research.maxSources ||
    !Array.isArray(response.ideas) ||
    response.ideas.length > PIPELINE.maxGeneratedCandidates
  ) {
    throw new TypeError("Research result contains invalid source or idea arrays.");
  }

  const sources = response.sources.map(normalizeResearchSource);
  if (sources.some((source) => source === null)) {
    throw new TypeError("Research result contains an invalid external source.");
  }
  const sourceIds = sources.map((source) => source.source_id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError("Research result contains duplicate external source IDs.");
  }
  const sourceUrls = sources.map((source) => source.url);
  if (new Set(sourceUrls).size !== sourceUrls.length) {
    throw new TypeError("Research result contains duplicate external source URLs.");
  }

  const ideas = response.ideas.map(normalizeStrictResearchIdea);
  if (ideas.some((idea) => idea === null)) {
    throw new TypeError("Research result contains an invalid idea candidate.");
  }
  const ranks = ideas.map((idea) => idea.rank);
  const sortedRanks = [...ranks].sort((left, right) => left - right);
  if (sortedRanks.some((rank, index) => rank !== index + 1)) {
    throw new TypeError("Research result idea ranks must be consecutive from one.");
  }

  return {
    schema_version: response.schema_version,
    assessment: {
      overall_evidence: response.assessment.overall_evidence,
      notes: response.assessment.notes.trim(),
    },
    sources,
    ideas,
  };
}

function createResearchClusterMap(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.schema_version !== PIPELINE.research.schemaVersion ||
    payload.prompt_version !== PIPELINE.research.promptVersion ||
    !Array.isArray(payload.clusters) ||
    payload.clusters.length < 1 ||
    payload.clusters.length > PIPELINE.maxClusters
  ) {
    throw new TypeError("Research job payload is invalid or unsupported.");
  }

  const clusters = new Map();
  for (const cluster of payload.clusters) {
    const clusterId = boundedString(cluster?.cluster_id, 64);
    if (!clusterId || clusters.has(clusterId) || !Array.isArray(cluster.evidence)) {
      throw new TypeError("Research job contains an invalid cluster.");
    }
    const sourceIds = new Set();
    for (const evidence of cluster.evidence) {
      const postId = recordId(evidence);
      if (!postId || sourceIds.has(postId)) {
        throw new TypeError("Research job contains invalid cluster evidence.");
      }
      sourceIds.add(postId);
    }
    if (sourceIds.size < PIPELINE.minimumEvidencePosts) {
      throw new TypeError("Research job contains insufficient cluster evidence.");
    }
    clusters.set(clusterId, { cluster, sourceIds });
  }
  return clusters;
}

/**
 * Validates a submitted scheduled-research result against its immutable job
 * payload and current-run post records. It never fetches submitted URLs.
 */
export function validateResearchResult(
  response,
  jobPayload,
  runPosts,
  {
    minimumEvidencePosts = PIPELINE.minimumEvidencePosts,
    minimumEvidenceAuthors = PIPELINE.minimumEvidenceAuthors,
    maxGeneratedCandidates = PIPELINE.maxGeneratedCandidates,
    maxPublishedIdeas = PIPELINE.maxPublishedIdeas,
  } = {},
) {
  const normalized = validateResearchResultShape(response);
  const clustersById = createResearchClusterMap(jobPayload);
  const postsById = createRecordMap(runPosts, "runPosts");
  const researchSourcesById = new Map(
    normalized.sources.map((source) => [source.source_id, source]),
  );
  const ideas = [];

  for (const idea of normalized.ideas) {
    const cluster = clustersById.get(idea.cluster_id);
    if (!cluster) {
      continue;
    }
    if (
      idea.source_post_ids.some(
        (postId) => !cluster.sourceIds.has(postId) || !postsById.has(postId),
      )
    ) {
      continue;
    }
    if (
      idea.research_source_ids.some(
        (sourceId) => !researchSourcesById.has(sourceId),
      )
    ) {
      continue;
    }

    const citedResearchIds = new Set(idea.research_source_ids);
    const mappedResearchIds = new Set();
    let claimMapIsValid = true;
    for (const mapping of idea.claim_source_map) {
      for (const sourceId of mapping.research_source_ids) {
        if (!citedResearchIds.has(sourceId)) {
          claimMapIsValid = false;
          break;
        }
        const source = researchSourcesById.get(sourceId);
        if (!source?.supported_claims.includes(mapping.claim)) {
          claimMapIsValid = false;
          break;
        }
        mappedResearchIds.add(sourceId);
      }
      if (!claimMapIsValid) break;
    }
    if (
      !claimMapIsValid ||
      [...citedResearchIds].some((sourceId) => !mappedResearchIds.has(sourceId))
    ) {
      continue;
    }

    const independentAuthorCount = new Set(
      idea.source_post_ids
        .map((postId) => authorId(postsById.get(postId)))
        .filter(Boolean),
    ).size;
    const validationErrors = [];
    if (idea.source_post_ids.length < minimumEvidencePosts) {
      validationErrors.push("insufficient_posts");
    }
    if (independentAuthorCount < minimumEvidenceAuthors) {
      validationErrors.push("insufficient_authors");
    }
    if (!PUBLISHABLE_OVERALL_EVIDENCE.has(normalized.assessment.overall_evidence)) {
      validationErrors.push("weak_overall_evidence");
    }
    if (idea.evidence_score < PIPELINE.minimumIdeaEvidence) {
      validationErrors.push("weak_idea_evidence");
    }
    if (idea.product_spec.delivery_mode !== "self_serve_web_app") {
      validationErrors.push("not_self_serve_web_app");
    }
    if (!PUBLISHABLE_SALES_MOTIONS.has(idea.product_spec.sales_motion)) {
      validationErrors.push("requires_sales_process");
    }
    if (
      idea.product_spec.mvp_build_weeks < PIPELINE.minimumMvpBuildWeeks ||
      idea.product_spec.mvp_build_weeks > PIPELINE.maximumMvpBuildWeeks
    ) {
      validationErrors.push("mvp_outside_2_to_6_weeks");
    }
    for (const check of IDEA_HARD_FILTER_CHECKS) {
      if (!idea.hard_filter_checks[check]) {
        validationErrors.push(`hard_filter_failed:${check}`);
      }
    }

    ideas.push({
      ...idea,
      independent_author_count: independentAuthorCount,
      publishable: validationErrors.length === 0,
      validation_errors: validationErrors,
    });
  }

  const effectiveMaxGenerated =
    Number.isInteger(maxGeneratedCandidates) && maxGeneratedCandidates >= 0
      ? maxGeneratedCandidates
      : 0;
  const effectiveMaxPublished =
    Number.isInteger(maxPublishedIdeas) && maxPublishedIdeas >= 0
      ? maxPublishedIdeas
      : 0;
  const rankedIdeas = ideas.sort(compareIdeas).slice(0, effectiveMaxGenerated);

  return {
    schema_version: normalized.schema_version,
    assessment: normalized.assessment,
    sources: normalized.sources,
    ideas: rankedIdeas,
    publishableIdeas: rankedIdeas
      .filter((idea) => idea.publishable)
      .slice(0, effectiveMaxPublished),
  };
}

// Temporary compatibility alias for older tests and historical imports. New
// production code must use validateResearchResult().
export function validateSolResponse(...args) {
  return validateLegacyIdeaResponse(...args);
}
