import { RetryableError } from "workflow";
import { PIPELINE } from "../lib/config.js";
import { buildClusterFingerprint } from "../lib/fingerprints.js";
import { substantiallySame } from "../lib/idea-deduplication.js";
import { embedTexts } from "../lib/openai/embeddings.js";
import { callStructured } from "../lib/openai/structured-response.js";
import {
  CLUSTER_GENERATION_SCHEMA_NAME,
  clusterGenerationSchema,
} from "../lib/ai-schemas/cluster-generation.js";
import {
  SIGNAL_EXTRACTION_SCHEMA_NAME,
  signalExtractionSchema,
} from "../lib/ai-schemas/signal-extraction.js";
import { buildClustersPrompt } from "../lib/prompts/build-clusters.js";
import { buildExtractSignalsPrompt } from "../lib/prompts/extract-signals.js";
import {
  boundIdeaGenerationClusters,
  buildResearchJobPayload,
} from "../lib/prompts/generate-ideas.js";
import {
  calculateOpportunityScore,
  rankPosts,
  selectHybridAiInput,
  selectSignals,
} from "../lib/ranking.js";
import { createSupabaseAdminClient } from "../lib/supabase/admin.js";
import { hashResearchJson } from "../lib/research/canonical-json.js";
import {
  validateLunaResponse,
  validateTerraResponse,
} from "../lib/validation.js";
import { XApiError } from "../lib/x/client.js";
import { buildXForYouConnectionCounts } from "../lib/x/for-you-connection.js";
import {
  purgeExpiredRawContent,
  refreshRetainedEvidence,
  upsertCurrentPosts,
} from "../lib/x/retention.js";
import { hydrateAndMergeForYouPosts } from "../lib/x/for-you-hydration.js";
import { searchHybridRecentPosts } from "../lib/x/search-posts.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = new Set(["completed", "no_ideas", "failed"]);

function requireWorkflowArgs({ runId, ownerId } = {}) {
  if (!UUID_PATTERN.test(runId || "") || !UUID_PATTERN.test(ownerId || "")) {
    throw new TypeError("The workflow requires valid run and owner IDs.");
  }
}

function throwDatabaseError(error, operation) {
  if (error) {
    const failure = new Error(`Database operation failed while ${operation}.`);
    failure.cause = error;
    throw failure;
  }
}

async function loadRun(db, runId, ownerId) {
  const { data, error } = await db
    .from("runs")
    .select("id, owner_id, status, stage, window_start, window_end, settings_snapshot, counts, usage, started_at")
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .single();

  throwDatabaseError(error, "loading the run");
  return data;
}

async function updateRun(db, runId, ownerId, values) {
  const { data, error } = await db
    .from("runs")
    .update(values)
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .in("status", ["queued", "running"])
    .select("id")
    .single();

  throwDatabaseError(error, "updating the run");
  if (!data) throw new Error("The research run no longer exists.");
}

function mergeUsage(current, key, usage) {
  const existing = current?.[key] || {};
  return {
    ...(current || {}),
    [key]: Object.fromEntries(
      [...new Set([...Object.keys(existing), ...Object.keys(usage || {})])].map((field) => [
        field,
        (Number(existing[field]) || 0) + (Number(usage?.[field]) || 0),
      ]),
    ),
  };
}

function addEmbeddingUsage(current, usage) {
  return mergeUsage(current, "embeddings", usage);
}

async function finishWithoutIdeas(db, run, counts = {}, usage = run.usage || {}) {
  await updateRun(db, run.id, run.owner_id, {
    status: "no_ideas",
    stage: null,
    counts: { ...(run.counts || {}), ...counts, ideas_saved: 0 },
    usage,
    error_message: null,
    completed_at: new Date().toISOString(),
  });
}

function retryXRateLimit(error) {
  if (error instanceof XApiError && error.isRateLimited) {
    const wait = Math.max(error.retryAfterMs || 60_000, 1_000);
    throw new RetryableError("X API rate limit reached.", {
      retryAfter: new Date(Date.now() + wait),
    });
  }
  throw error;
}

export async function fetchAndRank({
  runId,
  ownerId,
  forYouCandidates = [],
}) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];

  if (
    [
      "extracting",
      "clustering",
      "generating",
      "research_queued",
      "researching",
      "validating",
      "saving",
    ].includes(run.stage) &&
    Number(run.counts?.sent_to_luna) >= 5
  ) {
    const { data, error } = await db
      .from("run_posts")
      .select("post_id")
      .eq("run_id", runId)
      .eq("owner_id", ownerId)
      .eq("selected_for_ai", true)
      .order("deterministic_score", { ascending: false });
    throwDatabaseError(error, "recovering the ranked-post checkpoint");
    if ((data || []).length >= 5) return data.map((post) => post.post_id);
  }
  const now = new Date().toISOString();

  await updateRun(db, runId, ownerId, {
    status: "running",
    stage: "fetching",
    started_at: run.started_at || now,
    error_message: null,
  });

  let searchResult;
  try {
    await purgeExpiredRawContent(db, ownerId, now);
    await refreshRetainedEvidence(db, ownerId, now);
    const metricsCapturedAt = new Date().toISOString();
    const apiSearchResult = await searchHybridRecentPosts({
      query: run.settings_snapshot.x_query,
      followedUsernames: run.settings_snapshot.followed_x_usernames,
      startTime: run.window_start,
      endTime: run.window_end,
      qualityTime: metricsCapturedAt,
      candidateLimit: run.settings_snapshot.candidate_limit,
      aiInputLimit: run.settings_snapshot.ai_input_limit,
    });
    searchResult = apiSearchResult;
  } catch (error) {
    retryXRateLimit(error);
  }

  if (forYouCandidates.length) {
    try {
      searchResult = await hydrateAndMergeForYouPosts({
        searchResult,
        candidates: forYouCandidates,
        windowStart: run.window_start,
        windowEnd: run.window_end,
      });
    } catch {
      // This is an optional discovery lane. Lookup, rate-limit, or validation
      // failures must never discard the official followed/topic API result.
    }
  }

  const posts = searchResult.posts;
  // A workflow retry may reach this point after either write below committed.
  // Both canonical records and per-run snapshots therefore use their declared
  // unique keys as upsert conflicts rather than attempting a second insert.
  await upsertCurrentPosts({
    db,
    ownerId,
    now: searchResult.meta.metricsCapturedAt,
    posts,
  });

  const { error: clearError } = await db
    .from("run_posts")
    .delete()
    .eq("run_id", runId)
    .eq("owner_id", ownerId);
  throwDatabaseError(clearError, "clearing a prior candidate snapshot");

  if (posts.length) {
    const { error: snapshotError } = await db
      .from("run_posts")
      .upsert(posts.map((post) => ({
        run_id: runId,
        post_id: post.id,
        owner_id: ownerId,
        search_position: post.search_position,
        metrics: post.public_metrics,
        source_channel: post.source_channel,
      })), { onConflict: "run_id,post_id", ignoreDuplicates: false });
    throwDatabaseError(snapshotError, "saving candidate metrics");
  }

  const ranked = rankPosts(searchResult.rankablePosts, {
    now: searchResult.meta.metricsCapturedAt,
    // The official lanes are already bounded by candidate_limit. Rank the
    // complete additive pool so For You cannot truncate followed posts before
    // the followed-first selector gets a chance to preserve them.
    limit: searchResult.rankablePosts.length,
    prioritySourceChannel: "followed",
  });
  const selected = selectHybridAiInput(ranked, {
    limit: run.settings_snapshot.ai_input_limit,
  });

  if (selected.length) {
    const { error: rankingError } = await db
      .from("run_posts")
      .upsert(selected.map((post) => ({
        run_id: runId,
        post_id: post.id,
        owner_id: ownerId,
        search_position: post.search_position,
        metrics: post.public_metrics,
        source_channel: post.source_channel,
        deterministic_score: post.deterministic_score,
        selected_for_ai: true,
      })), { onConflict: "run_id,post_id", ignoreDuplicates: false });
    throwDatabaseError(rankingError, "saving deterministic rankings");
  }

  const forYouCounts = searchResult.meta.forYouRequested === undefined
    ? {}
    : {
        x_for_you_requested: searchResult.meta.forYouRequested,
        x_for_you_hydrated: searchResult.meta.forYouHydrated,
        x_for_you_returned: searchResult.meta.forYouReturned,
        x_for_you_unavailable: searchResult.meta.forYouUnavailable,
        x_for_you_unknown: searchResult.meta.forYouUnknown,
        x_for_you_outside_window: searchResult.meta.forYouOutsideWindow,
        x_for_you_cross_channel_duplicates:
          searchResult.meta.forYouCrossChannelDuplicates,
        x_for_you_reposts_rejected:
          searchResult.meta.forYouRepostsRejected,
        x_for_you_quotes_rejected: searchResult.meta.forYouQuotesRejected,
        x_for_you_view_quality_rejected:
          searchResult.meta.forYouViewQualityRejected,
        x_for_you_quality_passed: searchResult.meta.forYouQualityPassed,
        sent_to_luna_for_you: selected.filter(
          (post) => post.source_channel === "for_you",
        ).length,
      };
  const counts = {
    ...(run.counts || {}),
    x_returned: posts.length,
    x_raw_returned: searchResult.meta.rawResultCount,
    x_followed_accounts_configured:
      searchResult.meta.followedAccountsConfigured,
    x_followed_query_batches: searchResult.meta.followedQueryBatches,
    x_followed_requested: searchResult.meta.followedRequestedLimit,
    x_followed_returned: searchResult.meta.followedReturned,
    x_followed_batch_duplicates: searchResult.meta.followedBatchDuplicates,
    x_followed_quality_passed: searchResult.meta.followedQualityPassed,
    x_topic_requested: searchResult.meta.topicRequestedLimit,
    x_topic_returned: searchResult.meta.topicReturned,
    x_topic_quality_passed: searchResult.meta.topicQualityPassed,
    x_view_floor_passed: searchResult.meta.qualityPassed,
    x_cross_channel_duplicates: searchResult.meta.crossChannelDuplicates,
    x_metrics_captured_at: searchResult.meta.metricsCapturedAt,
    after_filtering: ranked.length,
    sent_to_luna: selected.length,
    sent_to_luna_followed: selected.filter(
      (post) => post.source_channel === "followed",
    ).length,
    sent_to_luna_topic: selected.filter(
      (post) => post.source_channel === "topic",
    ).length,
    ...forYouCounts,
    x_partial: searchResult.partial,
  };

  if (selected.length < 5) {
    await finishWithoutIdeas(db, run, counts);
    return [];
  }

  await updateRun(db, runId, ownerId, { counts, stage: "extracting" });
  return selected.map((post) => post.id);
}
fetchAndRank.maxRetries = 3;

async function loadSelectedPosts(db, runId, ownerId, selectedPostIds) {
  const { data: snapshots, error: snapshotsError } = await db
    .from("run_posts")
    .select("post_id, metrics, deterministic_score, relevant, signal_type, target_customer, problem, evidence_excerpt, signal_summary, commercial_score, hype_score, opportunity_score")
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .eq("selected_for_ai", true)
    .in("post_id", selectedPostIds);
  throwDatabaseError(snapshotsError, "loading selected post snapshots");

  const { data: posts, error: postsError } = await db
    .from("posts")
    .select("x_post_id, author_id, author_username, text, url, x_created_at")
    .eq("owner_id", ownerId)
    .in("x_post_id", selectedPostIds);
  throwDatabaseError(postsError, "loading selected posts");

  const postsById = new Map((posts || []).map((post) => [post.x_post_id, post]));
  return (snapshots || []).map((snapshot) => ({
    ...snapshot,
    id: snapshot.post_id,
    author_id: postsById.get(snapshot.post_id)?.author_id || "",
    author_username: postsById.get(snapshot.post_id)?.author_username || null,
    url: postsById.get(snapshot.post_id)?.url || null,
    x_created_at: postsById.get(snapshot.post_id)?.x_created_at || null,
    text: postsById.get(snapshot.post_id)?.text || "",
  }));
}

function qualifyingSignals(analyzedPosts) {
  return selectSignals(analyzedPosts).filter((signal) =>
    signal.author_id && signal.problem?.trim() && signal.signal_summary?.trim(),
  );
}

async function recoverSignalCheckpoint(db, runId, ownerId, selectedPostIds) {
  const posts = await loadSelectedPosts(db, runId, ownerId, selectedPostIds);

  if (
    posts.length !== selectedPostIds.length ||
    posts.some((post) => post.relevant === null)
  ) {
    throw new Error("The committed Luna checkpoint is incomplete.");
  }

  const signals = qualifyingSignals(posts);
  if (signals.length < 5) {
    throw new Error("The committed Luna checkpoint has too few signals.");
  }

  return signals.map((signal) => signal.post_id);
}

export function buildLunaCheckpointPayload(analyzedPosts) {
  return analyzedPosts.map((post) => ({
    post_id: post.post_id,
    relevant: post.relevant,
    signal_type: post.signal_type,
    target_customer: post.target_customer,
    problem: post.problem,
    evidence_excerpt: post.evidence_excerpt || null,
    signal_summary: post.signal_summary,
    commercial_score: post.commercial_score,
    hype_score: post.hype_score,
    opportunity_score: post.opportunity_score,
  }));
}

export async function extractSignals({ runId, ownerId, selectedPostIds }) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];

  if (
    [
      "clustering",
      "generating",
      "research_queued",
      "researching",
      "validating",
      "saving",
    ].includes(run.stage)
  ) {
    return recoverSignalCheckpoint(db, runId, ownerId, selectedPostIds);
  }

  await updateRun(db, runId, ownerId, { status: "running", stage: "extracting" });

  const posts = await loadSelectedPosts(db, runId, ownerId, selectedPostIds);
  if (posts.length !== selectedPostIds.length || posts.some((post) => !post.text)) {
    throw new Error("Selected X evidence could not be rehydrated.");
  }

  const response = await callStructured({
    model: PIPELINE.models.extraction,
    reasoningEffort: PIPELINE.reasoning.extraction,
    schemaName: SIGNAL_EXTRACTION_SCHEMA_NAME,
    schema: signalExtractionSchema,
    input: buildExtractSignalsPrompt(posts),
    maxOutputTokens: 24_000,
  });
  const validated = validateLunaResponse(response.data, posts);
  const byId = new Map(posts.map((post) => [post.post_id, post]));
  const analyzed = validated.items.map((item) => {
    const original = byId.get(item.post_id);
    return {
      ...original,
      ...item,
      signal_summary: item.summary,
      opportunity_score: calculateOpportunityScore({
        deterministic_score: original.deterministic_score,
        commercial_score: item.commercial_score,
        hype_score: item.hype_score,
      }),
    };
  });
  const signals = qualifyingSignals(analyzed);
  const { data: persistedSignals, error: checkpointError } = await db.rpc(
    "persist_luna_checkpoint",
    {
      p_owner_id: ownerId,
      p_run_id: runId,
      p_analyses: buildLunaCheckpointPayload(analyzed),
      p_counts: {
        sent_to_luna: posts.length,
        relevant_signals: signals.length,
      },
      p_luna_usage: response.usage,
      p_no_ideas: signals.length < 5,
    },
  );
  throwDatabaseError(checkpointError, "committing the Luna checkpoint");

  if (signals.length < 5) return [];

  const signalPostIds = (persistedSignals || []).map(
    (signal) => signal.signal_post_id,
  );
  if (signalPostIds.length < 5) {
    throw new Error("The Luna checkpoint did not return enough signals.");
  }

  return signalPostIds;
}
extractSignals.maxRetries = 3;

export function buildTerraCheckpointPayload(clusters) {
  return clusters.map((cluster) => ({
    title: cluster.title,
    target_customer: cluster.target_customer,
    problem: cluster.problem,
    why_now: cluster.why_now || null,
    summary: cluster.summary,
    evidence_post_ids: cluster.evidence_post_ids,
    evidence_strength: cluster.evidence_strength,
    payment_signal: cluster.payment_signal,
    eligible: cluster.eligible,
  }));
}

export async function buildClusters({ runId, ownerId, signalPostIds }) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];

  if (
    [
      "generating",
      "research_queued",
      "researching",
      "validating",
      "saving",
    ].includes(run.stage)
  ) {
    const { data, error } = await db
      .from("clusters")
      .select("id")
      .eq("run_id", runId)
      .eq("owner_id", ownerId)
      .eq("eligible", true)
      .order("evidence_strength", { ascending: false });
    throwDatabaseError(error, "recovering the cluster checkpoint");
    if ((data || []).length) return data.map((cluster) => cluster.id);
    throw new Error("The committed Terra checkpoint is incomplete.");
  }
  await updateRun(db, runId, ownerId, { status: "running", stage: "clustering" });

  const signals = await loadSelectedPosts(db, runId, ownerId, signalPostIds);
  const clusterInputs = signals.map((signal) => ({
    post_id: signal.post_id,
    author_id: signal.author_id,
    relevant: signal.relevant,
    signal_type: signal.signal_type,
    target_customer: signal.target_customer || "",
    problem: signal.problem,
    summary: signal.signal_summary,
    evidence_excerpt: signal.evidence_excerpt || "",
    opportunity_score: signal.opportunity_score,
  }));

  const response = await callStructured({
    model: PIPELINE.models.clustering,
    reasoningEffort: PIPELINE.reasoning.clustering,
    schemaName: CLUSTER_GENERATION_SCHEMA_NAME,
    schema: clusterGenerationSchema,
    input: buildClustersPrompt(clusterInputs),
    maxOutputTokens: 12_000,
  });
  const validated = validateTerraResponse(response.data, clusterInputs, {
    runPostIds: signalPostIds,
  });

  const checkpointClusters = [...validated.clusters]
    .sort(
      (left, right) =>
        Number(right.eligible) - Number(left.eligible) ||
        right.evidence_strength - left.evidence_strength ||
        right.payment_signal - left.payment_signal ||
        left.title.localeCompare(right.title),
    )
    .slice(0, PIPELINE.maxClusters);
  const eligibleCount = checkpointClusters.filter(
    (cluster) => cluster.eligible,
  ).length;
  const { data: persistedClusters, error: checkpointError } = await db.rpc(
    "persist_terra_checkpoint",
    {
      p_owner_id: ownerId,
      p_run_id: runId,
      p_clusters: buildTerraCheckpointPayload(checkpointClusters),
      p_counts: {
        clusters_created: checkpointClusters.length,
        eligible_clusters: eligibleCount,
      },
      p_terra_usage: response.usage,
      p_no_ideas: eligibleCount === 0,
    },
  );
  throwDatabaseError(checkpointError, "committing the Terra checkpoint");

  const eligibleClusterIds = (persistedClusters || [])
    .filter((cluster) => cluster.eligible)
    .map((cluster) => cluster.cluster_id);
  if (eligibleCount > 0 && !eligibleClusterIds.length) {
    throw new Error("The Terra checkpoint did not return eligible clusters.");
  }

  return eligibleClusterIds;
}
buildClusters.maxRetries = 3;

export { substantiallySame };

async function retrieveHistoricalIdeas(db, ownerId, runId, clusters, embeddings) {
  const matches = new Map();

  for (let index = 0; index < clusters.length; index += 1) {
    const { data, error } = await db.rpc("match_ideas", {
      p_owner_id: ownerId,
      p_embedding: embeddings[index],
      p_exclude_run_id: runId,
      p_limit: 5,
    });
    throwDatabaseError(error, "retrieving related historical ideas");

    for (const idea of data || []) {
      const prior = matches.get(idea.idea_id);
      if (!prior || Number(idea.similarity) > Number(prior.similarity)) {
        matches.set(idea.idea_id, idea);
      }
    }
  }

  return [...matches.values()]
    .sort((left, right) => Number(right.similarity) - Number(left.similarity))
    .slice(0, 20)
    .map((idea) => ({
      title: idea.title,
      fingerprint: idea.fingerprint,
      status: idea.status,
      feedback_reason: idea.feedback_reason,
    }));
}

async function loadFinalEvidence(db, runId, ownerId, clusterIds) {
  const { data: clusters, error: clusterError } = await db
    .from("clusters")
    .select("id, title, target_customer, problem, why_now, summary, evidence_post_ids, evidence_strength, payment_signal")
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .eq("eligible", true)
    .in("id", clusterIds);
  throwDatabaseError(clusterError, "loading eligible clusters");

  const evidenceIds = [...new Set((clusters || []).flatMap((cluster) => cluster.evidence_post_ids || []))];
  const runPosts = await loadSelectedPosts(db, runId, ownerId, evidenceIds);
  const byId = new Map(runPosts.map((post) => [post.post_id, post]));
  const promptClusters = (clusters || []).map((cluster) => ({
    ...cluster,
    evidence: cluster.evidence_post_ids
      .map((postId) => byId.get(postId))
      .filter(Boolean)
      .map((post) => ({
        post_id: post.post_id,
        author_id: post.author_id,
        author_username: post.author_username,
        url: post.url,
        x_created_at: post.x_created_at,
        signal_type: post.signal_type,
        evidence_excerpt: post.evidence_excerpt || "",
        metrics: post.metrics || {},
        opportunity_score: post.opportunity_score,
      })),
  })).filter((cluster) =>
    cluster.evidence.filter((item) => item.evidence_excerpt).length >= PIPELINE.minimumEvidencePosts &&
    new Set(
      cluster.evidence
        .filter((item) => item.evidence_excerpt)
        .map((item) => item.author_id)
        .filter(Boolean),
    ).size >= PIPELINE.minimumEvidenceAuthors,
  );

  return { clusters: promptClusters, runPosts, byId };
}

export async function prepareResearchJob({ runId, ownerId, clusterIds }) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return null;

  if (
    ["research_queued", "researching", "validating", "saving"].includes(
      run.stage,
    )
  ) {
    const { data, error } = await db
      .from("research_jobs")
      .select("id, schema_version, prompt_version, payload, payload_hash")
      .eq("run_id", runId)
      .eq("owner_id", ownerId)
      .maybeSingle();
    throwDatabaseError(error, "recovering the research-job checkpoint");
    if (data?.id) {
      if (run.status === "queued") {
        const { error: restoreError } = await db.rpc("persist_research_job", {
          p_owner_id: ownerId,
          p_run_id: runId,
          p_schema_version: data.schema_version,
          p_prompt_version: data.prompt_version,
          p_payload: data.payload,
          p_payload_hash: data.payload_hash,
          p_counts: run.counts || {},
          p_usage: run.usage || {},
        });
        throwDatabaseError(restoreError, "restoring the research-job checkpoint");
      }
      return data.id;
    }
    throw new Error("The committed research-job checkpoint is incomplete.");
  }

  await updateRun(db, runId, ownerId, {
    status: "running",
    stage: "generating",
  });

  const evidence = await loadFinalEvidence(db, runId, ownerId, clusterIds);
  if (!evidence.clusters.length) {
    await finishWithoutIdeas(db, run, {
      ...(run.counts || {}),
      eligible_clusters: 0,
    });
    return null;
  }
  const boundedClusters = boundIdeaGenerationClusters(evidence.clusters);

  let usage = run.usage || {};
  const clusterFingerprints = boundedClusters.map(buildClusterFingerprint);
  const clusterEmbeddingResult = await embedTexts(clusterFingerprints);
  usage = addEmbeddingUsage(usage, clusterEmbeddingResult.usage);
  const historicalIdeas = await retrieveHistoricalIdeas(
    db,
    ownerId,
    runId,
    boundedClusters,
    clusterEmbeddingResult.embeddings,
  );
  const payload = buildResearchJobPayload({
    runId,
    researchAsOf: run.window_end,
    clusters: boundedClusters,
    preferences: run.settings_snapshot.preferences,
    historicalIdeas,
  });
  const payloadHash = hashResearchJson(payload);
  const counts = {
    ...(run.counts || {}),
    eligible_clusters: boundedClusters.length,
    research_jobs_queued: 1,
  };
  const { data, error } = await db.rpc("persist_research_job", {
    p_owner_id: ownerId,
    p_run_id: runId,
    p_schema_version: PIPELINE.research.schemaVersion,
    p_prompt_version: PIPELINE.research.promptVersion,
    p_payload: payload,
    p_payload_hash: payloadHash,
    p_counts: counts,
    p_usage: usage,
  });
  throwDatabaseError(error, "persisting the research job");

  const jobId = data?.[0]?.research_job_id;
  if (!UUID_PATTERN.test(jobId || "")) {
    throw new Error("The research-job checkpoint did not return a job ID.");
  }
  return jobId;
}
prepareResearchJob.maxRetries = 3;

export async function recordXForYouConnectionStatus({
  runId,
  ownerId,
  authState,
  errorCode = null,
}) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  const checkedAt = new Date().toISOString();
  await updateRun(db, runId, ownerId, {
    counts: buildXForYouConnectionCounts(
      run.counts,
      { authState, errorCode },
      checkedAt,
    ),
  });

  return Object.freeze({ authState, checkedAt, errorCode });
}
recordXForYouConnectionStatus.maxRetries = 3;

export async function recordWorkflowFailure({ runId, ownerId, message }) {
  "use step";

  const db = createSupabaseAdminClient();
  const { error } = await db
    .from("runs")
    .update({
      status: "failed",
      error_message: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .in("status", ["queued", "running"]);
  throwDatabaseError(error, "recording the workflow failure");
}
recordWorkflowFailure.maxRetries = 3;
