import { PIPELINE } from "../lib/config.js";
import {
  duplicatesAcceptedIdea,
  isSemanticIdeaDuplicate,
} from "../lib/idea-deduplication.js";
import { fingerprintIdea } from "../lib/fingerprints.js";
import { embedTexts } from "../lib/openai/embeddings.js";
import { hashResearchJson } from "../lib/research/canonical-json.js";
import { createSupabaseAdminClient } from "../lib/supabase/admin.js";
import { validateResearchResult } from "../lib/validation.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireFinalizerArgs({ jobId, ownerId } = {}) {
  if (!UUID_PATTERN.test(jobId || "") || !UUID_PATTERN.test(ownerId || "")) {
    throw new TypeError("The finalizer requires valid job and owner IDs.");
  }
}

function throwDatabaseError(error, operation) {
  if (!error) return;
  const failure = new Error(`Database operation failed while ${operation}.`);
  failure.cause = error;
  throw failure;
}

function mergeUsage(current, key, usage) {
  const existing = current?.[key] || {};
  return {
    ...(current || {}),
    [key]: Object.fromEntries(
      [...new Set([...Object.keys(existing), ...Object.keys(usage || {})])].map(
        (field) => [
          field,
          (Number(existing[field]) || 0) + (Number(usage?.[field]) || 0),
        ],
      ),
    ),
  };
}

function addEmbeddingUsage(current, usage) {
  return mergeUsage(current, "embeddings", usage);
}

async function loadRun(db, runId, ownerId) {
  const { data, error } = await db
    .from("runs")
    .select("id, status, stage, counts, usage")
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .single();
  throwDatabaseError(error, "loading the research run");
  return data;
}

async function loadPublishedIdeaIds(db, runId, ownerId) {
  const { data, error } = await db
    .from("ideas")
    .select("id")
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .order("rank", { ascending: true });
  throwDatabaseError(error, "recovering researched ideas");
  return (data || []).map((idea) => idea.id);
}

function payloadPostIds(payload) {
  return [
    ...new Set(
      (payload?.candidates || [])
        .map((candidate) => candidate?.source_post?.post_id)
        .filter((postId) => typeof postId === "string" && postId),
    ),
  ];
}

function payloadCandidatesById(payload) {
  return new Map(
    (payload?.candidates || [])
      .filter(
        (candidate) =>
          typeof candidate?.candidate_id === "string" &&
          candidate.candidate_id,
      )
      .map((candidate) => [candidate.candidate_id, candidate]),
  );
}

async function loadResearchRunPosts(db, runId, ownerId, payload) {
  const postIds = payloadPostIds(payload);
  if (!postIds.length) {
    throw new Error("The research payload has no X evidence.");
  }

  const [snapshotsResult, postsResult] = await Promise.all([
    db
      .from("run_posts")
      .select("post_id, signal_type, signal_summary, problem")
      .eq("run_id", runId)
      .eq("owner_id", ownerId)
      .in("post_id", postIds),
    db
      .from("posts")
      .select("x_post_id, author_id")
      .eq("owner_id", ownerId)
      .in("x_post_id", postIds),
  ]);
  throwDatabaseError(
    snapshotsResult.error,
    "loading submitted X evidence snapshots",
  );
  throwDatabaseError(postsResult.error, "loading submitted X evidence authors");

  const postsById = new Map(
    (postsResult.data || []).map((post) => [post.x_post_id, post]),
  );
  const runPosts = (snapshotsResult.data || []).map((snapshot) => ({
    ...snapshot,
    author_id: postsById.get(snapshot.post_id)?.author_id || "",
  }));
  if (
    runPosts.length !== postIds.length ||
    runPosts.some((post) => !post.author_id)
  ) {
    throw new Error("The submitted X evidence no longer belongs to this run.");
  }
  return runPosts;
}

function aggregateIdeaResearchLinks(ideas) {
  return ideas.flatMap((idea) => {
    const claimsBySource = new Map(
      idea.research_source_ids.map((sourceId) => [sourceId, []]),
    );
    for (const mapping of idea.claim_source_map) {
      for (const sourceId of mapping.research_source_ids) {
        const claims = claimsBySource.get(sourceId);
        if (claims && !claims.includes(mapping.claim)) claims.push(mapping.claim);
      }
    }
    return [...claimsBySource].map(([sourceId, supportedClaims]) => ({
      fingerprint_hash: idea.fingerprint_hash,
      source_id: sourceId,
      supported_claims: supportedClaims,
    }));
  });
}

export async function finalizeResearchResult({ jobId, ownerId }) {
  "use step";

  requireFinalizerArgs({ jobId, ownerId });
  const db = createSupabaseAdminClient();
  const { data: validationRows, error: validationError } = await db.rpc(
    "begin_research_validation",
    { p_owner_id: ownerId, p_job_id: jobId },
  );
  throwDatabaseError(validationError, "claiming the research result");

  const checkpoint = validationRows?.[0];
  if (!checkpoint || !UUID_PATTERN.test(checkpoint.run_id || "")) {
    throw new Error("The research validation checkpoint is incomplete.");
  }
  const run = await loadRun(db, checkpoint.run_id, ownerId);
  if (checkpoint.already_completed) {
    return loadPublishedIdeaIds(db, run.id, ownerId);
  }
  if (run.status !== "running") {
    throw new Error("The research run is not active for validation.");
  }

  const payload = checkpoint.job_payload;
  const result = checkpoint.job_result;
  if (
    !payload ||
    !result ||
    payload.run_id !== run.id ||
    hashResearchJson(payload) !== checkpoint.payload_hash ||
    hashResearchJson(result) !== checkpoint.result_hash
  ) {
    throw new Error("The stored research payload or result failed integrity checks.");
  }
  if (
    payload.schema_version !== PIPELINE.research.schemaVersion ||
    payload.prompt_version !== PIPELINE.research.promptVersion ||
    result.schema_version !== PIPELINE.research.schemaVersion
  ) {
    throw new Error("The research payload or result version is unsupported.");
  }

  const runPosts = await loadResearchRunPosts(
    db,
    run.id,
    ownerId,
    payload,
  );
  const runPostsById = new Map(
    runPosts.map((post) => [post.post_id, post]),
  );
  const candidatesById = payloadCandidatesById(payload);
  const validated = validateResearchResult(result, payload, runPosts);
  const groundedCandidates = validated.ideas.filter(
    (idea) => idea.publishable,
  );
  const fingerprinted = groundedCandidates.map((idea) => ({
    ...idea,
    ...fingerprintIdea(idea),
  }));
  const candidateEmbeddingResult = await embedTexts(
    fingerprinted.map((idea) => idea.fingerprint),
  );
  const usage = addEmbeddingUsage(
    run.usage || {},
    candidateEmbeddingResult.usage,
  );

  let exactHashes = new Set();
  if (fingerprinted.length) {
    const { data: exactMatches, error } = await db
      .from("ideas")
      .select("fingerprint_hash")
      .eq("owner_id", ownerId)
      .neq("run_id", run.id)
      .in(
        "fingerprint_hash",
        fingerprinted.map((idea) => idea.fingerprint_hash),
      );
    throwDatabaseError(error, "checking exact researched-idea duplicates");
    exactHashes = new Set(
      (exactMatches || []).map((idea) => idea.fingerprint_hash),
    );
  }

  const accepted = [];
  let duplicatesRemoved = 0;
  for (let index = 0; index < fingerprinted.length; index += 1) {
    const idea = fingerprinted[index];
    const embedding = candidateEmbeddingResult.embeddings[index];
    if (
      exactHashes.has(idea.fingerprint_hash) ||
      duplicatesAcceptedIdea(idea, embedding, accepted)
    ) {
      duplicatesRemoved += 1;
      continue;
    }

    const { data: semanticMatches, error } = await db.rpc("match_ideas", {
      p_owner_id: ownerId,
      p_embedding: embedding,
      p_exclude_run_id: run.id,
      p_limit: 8,
    });
    throwDatabaseError(error, "checking semantic researched-idea duplicates");
    if (
      (semanticMatches || []).some((match) =>
        isSemanticIdeaDuplicate(idea, match, Number(match.similarity)),
      )
    ) {
      duplicatesRemoved += 1;
      continue;
    }

    accepted.push({ ...idea, embedding });
    exactHashes.add(idea.fingerprint_hash);
    if (accepted.length >= PIPELINE.maxPublishedIdeas) break;
  }

  const counts = {
    ...(run.counts || {}),
    candidates_researched: payload.candidates.length,
    candidates_validated: groundedCandidates.length,
    duplicates_removed: duplicatesRemoved,
    ideas_saved: accepted.length,
  };
  const ideaPayload = accepted.map((idea, index) => ({
    rank: index + 1,
    title: idea.title,
    target_customer: idea.target_customer,
    problem: idea.problem,
    offer: idea.offer,
    why_pay: idea.why_pay,
    why_now: idea.why_now,
    initial_price: idea.initial_price,
    differentiation: idea.differentiation,
    speed_to_first_revenue: idea.speed_to_first_revenue,
    validation_plan: idea.validation_plan,
    product_spec: idea.product_spec,
    hard_filter_checks: idea.hard_filter_checks,
    risks: idea.risks,
    assumptions: idea.assumptions,
    evidence_score: idea.evidence_score,
    fingerprint: idea.fingerprint,
    fingerprint_hash: idea.fingerprint_hash,
    embedding: idea.embedding,
  }));
  const xSourceRows = accepted.flatMap((idea) =>
    idea.source_post_ids.map((postId) => {
      const source = runPostsById.get(postId);
      const candidate = candidatesById.get(idea.candidate_id);
      return {
        fingerprint_hash: idea.fingerprint_hash,
        post_id: postId,
        signal_type: source.signal_type,
        evidence_summary:
          source.signal_summary ||
          source.problem ||
          candidate?.selected_idea?.problem_or_opportunity ||
          candidate?.selected_idea?.product,
      };
    }),
  );
  const acceptedResearchIds = new Set(
    accepted.flatMap((idea) => idea.research_source_ids),
  );
  const researchSourceRows = accepted.length
    ? validated.sources.filter((source) =>
        acceptedResearchIds.has(source.source_id),
      )
    : [];
  const ideaResearchSourceRows = aggregateIdeaResearchLinks(accepted);

  const { data: published, error: publishError } = await db.rpc(
    "publish_run_researched_ideas",
    {
      p_owner_id: ownerId,
      p_job_id: jobId,
      p_ideas: ideaPayload,
      p_x_sources: xSourceRows,
      p_research_sources: researchSourceRows,
      p_idea_research_sources: ideaResearchSourceRows,
      p_counts: counts,
      p_usage: usage,
    },
  );
  throwDatabaseError(publishError, "publishing researched ideas atomically");
  return (published || []).map((idea) => idea.idea_id);
}
finalizeResearchResult.maxRetries = 3;

export async function recordResearchFinalizerFailure({
  jobId,
  ownerId,
  message = "The submitted research could not be validated.",
}) {
  "use step";

  requireFinalizerArgs({ jobId, ownerId });
  const db = createSupabaseAdminClient();
  const { error } = await db.rpc("fail_research_job", {
    p_owner_id: ownerId,
    p_job_id: jobId,
    p_error_message: message,
  });
  throwDatabaseError(error, "recording the research finalizer failure");
}
recordResearchFinalizerFailure.maxRetries = 3;
