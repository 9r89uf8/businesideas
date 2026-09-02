import { PIPELINE } from "../lib/config.js";
import {
  CANDIDATE_GENERATION_SCHEMA_NAME,
  candidateGenerationSchema,
} from "../lib/ai-schemas/candidate-generation.js";
import {
  CONTEXT_HYDRATION_SCHEMA_NAME,
  contextHydrationSchema,
} from "../lib/ai-schemas/context-hydration.js";
import {
  POST_FILTER_SCHEMA_NAME,
  postFilterSchema,
} from "../lib/ai-schemas/post-filter.js";
import {
  POST_SHORTLIST_SCHEMA_NAME,
  postShortlistSchema,
} from "../lib/ai-schemas/post-shortlist.js";
import { fingerprintIdea } from "../lib/fingerprints.js";
import {
  duplicatesAcceptedIdea,
  isSemanticIdeaDuplicate,
} from "../lib/idea-deduplication.js";
import { embedTexts } from "../lib/openai/embeddings.js";
import { callStructured } from "../lib/openai/structured-response.js";
import { buildCandidateGenerationPrompt } from "../lib/prompts/candidate-generation.js";
import { buildContextHydrationPrompt } from "../lib/prompts/context-hydration.js";
import { buildPostFilterPrompt } from "../lib/prompts/post-filter.js";
import { buildPostShortlistPrompt } from "../lib/prompts/post-shortlist.js";
import { buildResearchJobPayload } from "../lib/prompts/generate-ideas.js";
import { hashResearchJson } from "../lib/research/canonical-json.js";
import { normalizePublicResearchUrl } from "../lib/research/public-url.js";
import { calculateOpportunityScore } from "../lib/ranking.js";
import { createSupabaseAdminClient } from "../lib/supabase/admin.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = new Set(["completed", "no_ideas", "failed"]);
const COMMERCIAL_ELEMENTS = new Set([
  "capability",
  "problem",
  "request",
  "result",
  "spending",
  "change",
  "none",
]);
const FILTER_DECISIONS = new Set(["keep", "reject", "needs_context"]);
const CONTEXT_STATUSES = new Set(["resolved", "insufficient", "unavailable"]);
const SHORTLIST_DECISIONS = new Set(["advance", "hold", "reject"]);
const POST_IDEATION_STAGES = new Set([
  "generating",
  "research_queued",
  "researching",
  "validating",
  "saving",
]);

function requireWorkflowArgs({ runId, ownerId } = {}) {
  if (!UUID_PATTERN.test(runId || "") || !UUID_PATTERN.test(ownerId || "")) {
    throw new TypeError("The ideation workflow requires valid run and owner IDs.");
  }
}

function throwDatabaseError(error, operation) {
  if (!error) return;
  const failure = new Error(`Database operation failed while ${operation}.`);
  failure.cause = error;
  throw failure;
}

function nonempty(value, maximum = 4_000) {
  return typeof value === "string" && value.trim() && value.length <= maximum;
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

function aggregateUsage(values) {
  return (Array.isArray(values) ? values : []).reduce((total, usage) => {
    for (const [key, value] of Object.entries(usage || {})) {
      if (Number.isFinite(Number(value))) {
        total[key] = (Number(total[key]) || 0) + Number(value);
      }
    }
    return total;
  }, {});
}

async function loadRun(db, runId, ownerId) {
  const { data, error } = await db
    .from("runs")
    .select(
      "id, owner_id, status, stage, window_end, settings_snapshot, counts, usage, started_at",
    )
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .single();
  throwDatabaseError(error, "loading the ideation run");
  return data;
}

async function updateActiveRun(db, runId, ownerId, values) {
  const { data, error } = await db
    .from("runs")
    .update(values)
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .in("status", ["queued", "running"])
    .select("id")
    .maybeSingle();
  throwDatabaseError(error, "updating the ideation run");
  if (!data) throw new Error("The ideation run is no longer active.");
}

async function finishWithoutIdeas(db, run, counts = {}, usage = run.usage || {}) {
  await updateActiveRun(db, run.id, run.owner_id, {
    status: "no_ideas",
    stage: null,
    counts: { ...(run.counts || {}), ...counts, ideas_saved: 0 },
    usage,
    error_message: null,
    completed_at: new Date().toISOString(),
  });
}

async function loadIdeationPosts(db, runId, ownerId, postIds) {
  const ids = [...new Set(postIds || [])];
  if (!ids.length) return [];

  const [snapshotsResult, postsResult] = await Promise.all([
    db
      .from("run_posts")
      .select(
        "post_id, search_position, metrics, deterministic_score, source_channel, filter_decision, filter_reason, commercial_element, hydrated_context, shortlist_assessment, relevant, signal_type, signal_summary, problem",
      )
      .eq("run_id", runId)
      .eq("owner_id", ownerId)
      .eq("selected_for_ai", true)
      .in("post_id", ids),
    db
      .from("posts")
      .select(
        "x_post_id, author_id, author_username, text, url, x_created_at, source_context",
      )
      .eq("owner_id", ownerId)
      .in("x_post_id", ids),
  ]);
  throwDatabaseError(snapshotsResult.error, "loading ideation snapshots");
  throwDatabaseError(postsResult.error, "loading ideation posts");

  const snapshots = new Map(
    (snapshotsResult.data || []).map((item) => [item.post_id, item]),
  );
  const posts = new Map(
    (postsResult.data || []).map((item) => [item.x_post_id, item]),
  );
  const combined = ids.flatMap((postId) => {
    const snapshot = snapshots.get(postId);
    const post = posts.get(postId);
    return snapshot && post
      ? [{ ...snapshot, ...post, post_id: postId }]
      : [];
  });
  if (combined.length !== ids.length || combined.some((post) => !post.text)) {
    throw new Error("Selected X posts could not be rehydrated for ideation.");
  }
  return combined;
}

function validateExactItems(items, postIds, label) {
  if (!Array.isArray(items) || items.length !== postIds.length) {
    throw new Error(`${label} must return every input post exactly once.`);
  }
  const expected = new Set(postIds);
  const returned = new Set();
  for (const item of items) {
    if (!expected.has(item?.post_id) || returned.has(item.post_id)) {
      throw new Error(`${label} returned an unknown or duplicate post ID.`);
    }
    returned.add(item.post_id);
  }
}

function validateFilterResult(data, posts) {
  const postIds = posts.map((post) => post.post_id);
  validateExactItems(data?.items, postIds, "Post filtering");
  return data.items.map((item) => {
    if (
      !FILTER_DECISIONS.has(item.decision) ||
      !COMMERCIAL_ELEMENTS.has(item.commercial_element) ||
      !nonempty(item.reason, 500)
    ) {
      throw new Error("Post filtering returned an invalid decision.");
    }
    return {
      post_id: item.post_id,
      decision: item.decision,
      reason: item.reason.trim(),
      commercial_element: item.commercial_element,
    };
  });
}

function signalTypeFor(element) {
  return {
    capability: "new_capability",
    change: "new_capability",
    problem: "pain",
    request: "request",
    result: "workaround",
    spending: "spending",
    none: "none",
  }[element] || "none";
}

function filterOutcome(posts) {
  const survivorPostIds = posts
    .filter((post) => post.filter_decision !== "reject")
    .map((post) => post.post_id);
  const needsContextPostIds = posts
    .filter((post) => post.filter_decision === "needs_context")
    .map((post) => post.post_id);
  return { survivorPostIds, needsContextPostIds };
}

export async function filterCommercialPosts({ runId, ownerId, selectedPostIds }) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  if (
    !Array.isArray(selectedPostIds) ||
    selectedPostIds.length < 1 ||
    selectedPostIds.length > PIPELINE.maxForYouInput
  ) {
    throw new TypeError("Post filtering requires one to 30 selected posts.");
  }

  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { survivorPostIds: [], needsContextPostIds: [] };
  }
  const posts = await loadIdeationPosts(
    db,
    runId,
    ownerId,
    selectedPostIds,
  );

  let decisions;
  if (posts.every((post) => FILTER_DECISIONS.has(post.filter_decision))) {
    decisions = posts.map((post) => ({
      post_id: post.post_id,
      decision: post.filter_decision,
      reason: post.filter_reason,
      commercial_element: post.commercial_element,
    }));
  } else {
    const response = await callStructured({
      model: PIPELINE.models.extraction,
      reasoningEffort: PIPELINE.reasoning.extraction,
      schemaName: POST_FILTER_SCHEMA_NAME,
      schema: postFilterSchema,
      input: buildPostFilterPrompt(posts),
      maxOutputTokens: 8_000,
    });
    decisions = validateFilterResult(response.data, posts);
    const byId = new Map(posts.map((post) => [post.post_id, post]));
    const { error } = await db.from("run_posts").upsert(
      decisions.map((item) => {
        const post = byId.get(item.post_id);
        const relevant = item.decision !== "reject";
        const commercialScore =
          item.decision === "keep" ? 75 : item.decision === "needs_context" ? 55 : 0;
        const hypeScore = item.decision === "reject" ? 100 : 0;
        return {
          run_id: runId,
          post_id: item.post_id,
          owner_id: ownerId,
          filter_decision: item.decision,
          filter_reason: item.reason,
          commercial_element: item.commercial_element,
          relevant,
          signal_type: signalTypeFor(item.commercial_element),
          target_customer: null,
          problem: item.reason,
          evidence_excerpt: null,
          signal_summary: item.reason,
          commercial_score: commercialScore,
          hype_score: hypeScore,
          opportunity_score: calculateOpportunityScore({
            deterministic_score: post.deterministic_score,
            commercial_score: commercialScore,
            hype_score: hypeScore,
          }),
        };
      }),
      { onConflict: "run_id,post_id", ignoreDuplicates: false },
    );
    throwDatabaseError(error, "saving post-filter decisions");

    const counts = {
      ...(run.counts || {}),
      filter_kept: decisions.filter((item) => item.decision === "keep").length,
      filter_needs_context: decisions.filter(
        (item) => item.decision === "needs_context",
      ).length,
      filter_rejected: decisions.filter((item) => item.decision === "reject")
        .length,
      relevant_signals: decisions.filter((item) => item.decision !== "reject")
        .length,
    };
    const usage = mergeUsage(run.usage, "luna_filter", response.usage);
    if (counts.relevant_signals === 0) {
      await finishWithoutIdeas(db, run, counts, usage);
      return { survivorPostIds: [], needsContextPostIds: [] };
    }
    await updateActiveRun(db, runId, ownerId, {
      status: "running",
      stage: "shortlisting",
      counts,
      usage,
      error_message: null,
    });
  }

  const outcome = filterOutcome(
    decisions.map((item) => ({
      post_id: item.post_id,
      filter_decision: item.decision,
    })),
  );
  if (!outcome.survivorPostIds.length && !TERMINAL_RUN_STATUSES.has(run.status)) {
    await finishWithoutIdeas(db, run, {
      filter_kept: 0,
      filter_needs_context: 0,
      filter_rejected: decisions.length,
      relevant_signals: 0,
    });
  } else if (run.stage === "extracting") {
    await updateActiveRun(db, runId, ownerId, {
      status: "running",
      stage: "shortlisting",
      error_message: null,
    });
  }
  return outcome;
}
filterCommercialPosts.maxRetries = 3;

function contextSources(sourceContext) {
  const context =
    sourceContext && typeof sourceContext === "object" ? sourceContext : {};
  const sources = [];
  const add = (value) => {
    if (sources.length >= 5) return;
    if (value.url || value.title || value.content) sources.push(value);
  };

  for (const url of Array.isArray(context.urls) ? context.urls : []) {
    add({
      kind: "link",
      url: url?.url || "",
      title: url?.title || "",
      content: url?.description || "",
    });
  }
  if (context.note_tweet) {
    add({
      kind: "long_post",
      url: context.note_tweet.urls?.[0]?.url || "",
      title: "",
      content: context.note_tweet.text || "",
    });
  }
  if (context.article) {
    add({
      kind: "article",
      url: context.article.urls?.[0]?.url || "",
      title: context.article.title || "",
      content: [
        context.article.description,
        context.article.text,
      ].filter(Boolean).join("\n"),
    });
  }
  for (const media of Array.isArray(context.media) ? context.media : []) {
    add({
      kind: media?.type || "media",
      url: "",
      title: "",
      content: media?.alt_text || "",
    });
  }
  return sources;
}

function validateContextResult(data, posts) {
  const postIds = posts.map((post) => post.post_id);
  validateExactItems(data?.items, postIds, "Context hydration");
  return data.items.map((item) => {
    if (
      !CONTEXT_STATUSES.has(item.status) ||
      !COMMERCIAL_ELEMENTS.has(item.commercial_element) ||
      !nonempty(item.reason, 500) ||
      !Array.isArray(item.source_urls) ||
      item.source_urls.length > 5
    ) {
      throw new Error("Context hydration returned an invalid item.");
    }
    const sourceUrls = item.source_urls.map((url) => {
      const normalized = normalizePublicResearchUrl(url);
      if (!normalized) throw new Error("Context hydration returned an unsafe URL.");
      return normalized;
    });
    if (
      item.status === "resolved" &&
      (!nonempty(item.context_summary, 2_000) || item.commercial_element === "none")
    ) {
      throw new Error("Resolved linked context is incomplete.");
    }
    if (item.status !== "resolved" && item.context_summary) {
      throw new Error("Unresolved linked context must not include a summary.");
    }
    return {
      post_id: item.post_id,
      status: item.status,
      context_summary: item.context_summary.trim(),
      commercial_element: item.commercial_element,
      source_urls: [...new Set(sourceUrls)],
      reason: item.reason.trim(),
    };
  });
}

export async function hydrateNeededPostContext({
  runId,
  ownerId,
  survivorPostIds,
  needsContextPostIds,
}) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const survivors = [...new Set(survivorPostIds || [])];
  const needed = [...new Set(needsContextPostIds || [])];
  if (needed.some((postId) => !survivors.includes(postId))) {
    throw new TypeError("Context post IDs must belong to the filtered survivors.");
  }
  if (!needed.length) return survivors;

  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];
  const posts = await loadIdeationPosts(db, runId, ownerId, survivors);
  const neededPosts = posts.filter((post) => needed.includes(post.post_id));
  const unresolved = neededPosts.filter(
    (post) => !CONTEXT_STATUSES.has(post.hydrated_context?.status),
  );
  if (POST_IDEATION_STAGES.has(run.stage) && unresolved.length) {
    throw new Error("The saved context checkpoint is incomplete.");
  }

  let responseUsage = null;
  if (unresolved.length) {
    const response = await callStructured({
      model: PIPELINE.models.context,
      reasoningEffort: PIPELINE.reasoning.context,
      schemaName: CONTEXT_HYDRATION_SCHEMA_NAME,
      schema: contextHydrationSchema,
      input: buildContextHydrationPrompt(
        unresolved.map((post) => ({
          post_id: post.post_id,
          text: post.text,
          context_sources: contextSources(post.source_context),
        })),
      ),
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "low",
        },
      ],
      toolChoice: "auto",
      maxToolCalls: Math.min(20, Math.max(1, unresolved.length * 2)),
      maxOutputTokens: 8_000,
    });
    const hydrated = validateContextResult(response.data, unresolved);
    const { error } = await db.from("run_posts").upsert(
      hydrated.map((item) => ({
        run_id: runId,
        post_id: item.post_id,
        owner_id: ownerId,
        hydrated_context: item,
      })),
      { onConflict: "run_id,post_id", ignoreDuplicates: false },
    );
    throwDatabaseError(error, "saving hydrated post context");
    responseUsage = response.usage;
    const hydratedById = new Map(hydrated.map((item) => [item.post_id, item]));
    for (const post of neededPosts) {
      if (hydratedById.has(post.post_id)) {
        post.hydrated_context = hydratedById.get(post.post_id);
      }
    }
  }

  const resolved = new Set(
    neededPosts
      .filter((post) => post.hydrated_context?.status === "resolved")
      .map((post) => post.post_id),
  );
  const remaining = survivors.filter(
    (postId) => !needed.includes(postId) || resolved.has(postId),
  );
  const counts = {
    ...(run.counts || {}),
    context_requested: needed.length,
    context_resolved: resolved.size,
    context_unavailable: needed.length - resolved.size,
    shortlist_survivors: remaining.length,
  };
  const usage = responseUsage
    ? mergeUsage(run.usage, "context_hydration", responseUsage)
    : run.usage || {};
  if (!remaining.length) {
    if (POST_IDEATION_STAGES.has(run.stage)) {
      throw new Error("The saved context checkpoint has no survivors.");
    }
    await finishWithoutIdeas(db, run, counts, usage);
    return [];
  }
  if (POST_IDEATION_STAGES.has(run.stage)) return remaining;
  await updateActiveRun(db, runId, ownerId, {
    status: "running",
    stage: "shortlisting",
    counts,
    usage,
    error_message: null,
  });
  return remaining;
}
hydrateNeededPostContext.maxRetries = 3;

function validateShortlistResult(data, posts) {
  const postIds = posts.map((post) => post.post_id);
  validateExactItems(data?.assessments, postIds, "Post shortlisting");
  if (!Array.isArray(data?.advanced_post_ids)) {
    throw new Error("Post shortlisting omitted advanced post IDs.");
  }
  const advanced = [...new Set(data.advanced_post_ids)];
  if (
    advanced.length !== data.advanced_post_ids.length ||
    advanced.length > PIPELINE.maxShortlistedPosts ||
    advanced.some((postId) => !postIds.includes(postId))
  ) {
    throw new Error("Post shortlisting returned invalid advanced post IDs.");
  }
  const assessments = data.assessments.map((item) => {
    if (
      !SHORTLIST_DECISIONS.has(item.decision) ||
      !Number.isInteger(item.commercial_inspiration_score) ||
      item.commercial_inspiration_score < 0 ||
      item.commercial_inspiration_score > 100 ||
      !nonempty(item.what_changed, 1_000) ||
      !nonempty(item.reason, 500) ||
      typeof item.possible_payer !== "string" ||
      typeof item.one_line_build_angle !== "string"
    ) {
      throw new Error("Post shortlisting returned an invalid assessment.");
    }
    const isAdvanced = advanced.includes(item.post_id);
    if ((item.decision === "advance") !== isAdvanced) {
      throw new Error("Post shortlisting decisions do not match the advanced IDs.");
    }
    if (
      !nonempty(item.possible_payer, 500) ||
      !nonempty(item.one_line_build_angle, 1_000)
    ) {
      throw new Error("Every shortlist assessment requires a payer and build angle.");
    }
    return { ...item, advanced: isAdvanced };
  });
  return { assessments, advancedPostIds: advanced };
}

function directShortlist(posts) {
  return {
    assessments: posts.map((post) => ({
      post_id: post.post_id,
      commercial_inspiration_score: 50,
      what_changed: post.filter_reason || post.text.slice(0, 1_000),
      possible_payer: "",
      one_line_build_angle: "",
      decision: "advance",
      reason: "The survivor set is small enough for independent generation.",
      advanced: true,
    })),
    advancedPostIds: posts.map((post) => post.post_id),
  };
}

async function loadSavedShortlist(db, runId, ownerId) {
  const { data, error } = await db
    .from("clusters")
    .select("id, source_post_id, evidence_strength")
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .eq("eligible", true)
    .not("source_post_id", "is", null)
    .order("evidence_strength", { ascending: false });
  throwDatabaseError(error, "recovering the post shortlist");
  return (data || []).map((item) => ({
    clusterId: item.id,
    postId: item.source_post_id,
  }));
}

export async function shortlistCommercialPosts({
  runId,
  ownerId,
  survivorPostIds,
}) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const survivorIds = [...new Set(survivorPostIds || [])];
  if (!survivorIds.length || survivorIds.length > PIPELINE.maxForYouInput) {
    throw new TypeError("Post shortlisting requires one to 30 survivors.");
  }

  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return [];
  const savedShortlist = await loadSavedShortlist(db, runId, ownerId);
  if (
    savedShortlist.length &&
    [
      "generating",
      "research_queued",
      "researching",
      "validating",
      "saving",
    ].includes(run.stage)
  ) {
    return savedShortlist;
  }

  const posts = await loadIdeationPosts(db, runId, ownerId, survivorIds);
  let result;
  let responseUsage = null;
  const savedAssessments = posts.map((post) => post.shortlist_assessment);
  if (savedAssessments.every((item) => item && typeof item === "object")) {
    result = {
      assessments: savedAssessments,
      advancedPostIds: savedAssessments
        .filter((item) => item.advanced)
        .map((item) => item.post_id),
    };
  } else if (posts.length <= PIPELINE.maxShortlistedPosts) {
    result = directShortlist(posts);
  } else {
    const response = await callStructured({
      model: PIPELINE.models.shortlist,
      reasoningEffort: PIPELINE.reasoning.shortlist,
      schemaName: POST_SHORTLIST_SCHEMA_NAME,
      schema: postShortlistSchema,
      input: buildPostShortlistPrompt(
        posts.map((post) => ({
          post_id: post.post_id,
          text: post.text,
          commercial_element: post.commercial_element,
          context_summary: post.hydrated_context?.context_summary || "",
        })),
      ),
      maxOutputTokens: 12_000,
    });
    result = validateShortlistResult(response.data, posts);
    responseUsage = response.usage;
  }

  const advanced = new Set(result.advancedPostIds);
  const assessments = result.assessments.map((item) => ({
    ...item,
    advanced: advanced.has(item.post_id),
  }));
  const { error: assessmentError } = await db.from("run_posts").upsert(
    assessments.map((item) => ({
      run_id: runId,
      post_id: item.post_id,
      owner_id: ownerId,
      shortlist_assessment: item,
    })),
    { onConflict: "run_id,post_id", ignoreDuplicates: false },
  );
  throwDatabaseError(assessmentError, "saving shortlist assessments");

  const { error: clearError } = await db
    .from("clusters")
    .delete()
    .eq("run_id", runId)
    .eq("owner_id", ownerId);
  throwDatabaseError(clearError, "clearing a prior post shortlist");

  let shortlist = [];
  const selectedAssessments = assessments.filter((item) => item.advanced);
  if (selectedAssessments.length) {
    const { data, error } = await db
      .from("clusters")
      .insert(
        selectedAssessments.map((item) => ({
          run_id: runId,
          owner_id: ownerId,
          title: item.one_line_build_angle || "Post-first business candidate",
          target_customer: item.possible_payer || "Payer to be established",
          problem: item.what_changed,
          why_now: item.reason,
          summary: item.one_line_build_angle || item.reason,
          evidence_post_ids: [item.post_id],
          evidence_strength: item.commercial_inspiration_score,
          payment_signal: item.possible_payer
            ? item.commercial_inspiration_score
            : 0,
          eligible: true,
          source_post_id: item.post_id,
        })),
      )
      .select("id, source_post_id");
    throwDatabaseError(error, "saving the post shortlist");
    shortlist = (data || []).map((item) => ({
      clusterId: item.id,
      postId: item.source_post_id,
    }));
  }

  const counts = {
    ...(run.counts || {}),
    shortlist_survivors: posts.length,
    shortlisted_posts: shortlist.length,
    shortlist_skipped: posts.length <= PIPELINE.maxShortlistedPosts,
  };
  const usage = responseUsage
    ? mergeUsage(run.usage, "sol_shortlist", responseUsage)
    : run.usage || {};
  if (!shortlist.length) {
    await finishWithoutIdeas(db, run, counts, usage);
    return [];
  }
  await updateActiveRun(db, runId, ownerId, {
    status: "running",
    stage: "generating",
    counts,
    usage,
    error_message: null,
  });
  return shortlist;
}
shortlistCommercialPosts.maxRetries = 3;

function validateCandidateResult(data, postId) {
  if (
    !data ||
    !["candidate", "no_viable_idea"].includes(data.status) ||
    data.source_post_id !== postId ||
    !Array.isArray(data.concepts_considered) ||
    data.concepts_considered.length !== 3 ||
    !nonempty(data.reason, 1_000)
  ) {
    throw new Error("Candidate generation returned an invalid result.");
  }
  if (data.status === "candidate") {
    if (
      !data.selected_idea ||
      typeof data.selected_idea !== "object" ||
      !Number.isInteger(data.selected_idea.score) ||
      data.selected_idea.score < 0 ||
      data.selected_idea.score > 100
    ) {
      throw new Error("Candidate generation omitted the selected idea.");
    }
  } else if (data.selected_idea !== null) {
    throw new Error("A rejected generation result must not select an idea.");
  }
  return data;
}

export async function generateCandidateForPost({
  runId,
  ownerId,
  clusterId,
  postId,
}) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  if (!UUID_PATTERN.test(clusterId || "") || !/^\d{1,32}$/.test(postId || "")) {
    throw new TypeError("Candidate generation requires a valid shortlist unit.");
  }
  const db = createSupabaseAdminClient();
  const { data: cluster, error: clusterError } = await db
    .from("clusters")
    .select("id, source_post_id, candidate_result, candidate_usage")
    .eq("id", clusterId)
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .eq("source_post_id", postId)
    .maybeSingle();
  throwDatabaseError(clusterError, "loading a shortlist unit");
  if (!cluster) throw new Error("The shortlist unit was not found.");
  if (cluster.candidate_result) {
    return {
      clusterId,
      postId,
      status: cluster.candidate_result.status,
    };
  }

  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { clusterId, postId, status: "skipped" };
  }
  const [post] = await loadIdeationPosts(db, runId, ownerId, [postId]);
  const response = await callStructured({
    model: PIPELINE.models.generation,
    reasoningEffort: PIPELINE.reasoning.generation,
    schemaName: CANDIDATE_GENERATION_SCHEMA_NAME,
    schema: candidateGenerationSchema,
    input: buildCandidateGenerationPrompt({
      post_id: postId,
      text: post.text,
      context_summary: post.hydrated_context?.context_summary || "",
      preferences: run.settings_snapshot?.preferences || {},
    }),
    maxOutputTokens: 8_000,
    promptCacheKey: "sf-candidate-generation-v1",
  });
  const result = validateCandidateResult(response.data, postId);
  const { data: saved, error } = await db
    .from("clusters")
    .update({
      candidate_result: result,
      candidate_usage: response.usage,
    })
    .eq("id", clusterId)
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .is("candidate_result", null)
    .select("id")
    .maybeSingle();
  throwDatabaseError(error, "saving an isolated candidate result");
  if (!saved) {
    const { data: recovered, error: recoveryError } = await db
      .from("clusters")
      .select("candidate_result")
      .eq("id", clusterId)
      .eq("owner_id", ownerId)
      .maybeSingle();
    throwDatabaseError(recoveryError, "recovering an isolated candidate result");
    if (!recovered?.candidate_result) {
      throw new Error("The candidate result was not saved.");
    }
  }
  return { clusterId, postId, status: result.status };
}
generateCandidateForPost.maxRetries = 3;

function candidateForDedup(cluster) {
  const selected = cluster.candidate_result.selected_idea;
  return {
    candidate_id: cluster.id,
    source_post_id: cluster.source_post_id,
    target_customer: selected.payer,
    problem: selected.problem_or_opportunity,
    offer: selected.product,
    initial_price: selected.pricing_hypothesis,
    selected_idea: selected,
    ...fingerprintIdea({
      target_customer: selected.payer,
      problem: selected.problem_or_opportunity,
      offer: selected.product,
      initial_price: selected.pricing_hypothesis,
    }),
  };
}

function compactResearchContext(post) {
  if (post.hydrated_context?.status === "resolved") {
    return {
      status: "resolved",
      context_summary: String(
        post.hydrated_context.context_summary || "",
      ).slice(0, 3_000),
      source_urls: (post.hydrated_context.source_urls || [])
        .slice(0, 4)
        .map((url) => String(url).slice(0, 1_024)),
    };
  }

  const sources = contextSources(post.source_context)
    .slice(0, 4)
    .map((source) => ({
      kind: String(source.kind || "linked_context").slice(0, 64),
      url: String(source.url || "").slice(0, 1_024),
      title: String(source.title || "").slice(0, 300),
      content: String(source.content || "").slice(0, 1_500),
    }));
  return sources.length ? { sources } : null;
}

async function loadExistingResearchJob(db, runId, ownerId) {
  const { data, error } = await db
    .from("research_jobs")
    .select("id, schema_version, prompt_version, payload, payload_hash")
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  throwDatabaseError(error, "recovering the candidate research job");
  return data;
}

export async function prepareCandidateResearchJob({
  runId,
  ownerId,
  clusterIds,
}) {
  "use step";

  requireWorkflowArgs({ runId, ownerId });
  const shortlistIds = [...new Set(clusterIds || [])];
  if (!shortlistIds.length || shortlistIds.length > PIPELINE.maxShortlistedPosts) {
    throw new TypeError("Candidate research requires one to eight shortlist units.");
  }
  const db = createSupabaseAdminClient();
  const run = await loadRun(db, runId, ownerId);
  if (TERMINAL_RUN_STATUSES.has(run.status)) return null;

  if (
    ["research_queued", "researching", "validating", "saving"].includes(
      run.stage,
    )
  ) {
    const existing = await loadExistingResearchJob(db, runId, ownerId);
    if (existing?.id) {
      if (run.status === "queued") {
        const { error } = await db.rpc("persist_research_job", {
          p_owner_id: ownerId,
          p_run_id: runId,
          p_schema_version: existing.schema_version,
          p_prompt_version: existing.prompt_version,
          p_payload: existing.payload,
          p_payload_hash: existing.payload_hash,
          p_counts: run.counts || {},
          p_usage: run.usage || {},
        });
        throwDatabaseError(error, "restoring the candidate research job");
      }
      return existing.id;
    }
    throw new Error("The committed candidate research job is incomplete.");
  }

  const { data: clusters, error: clusterError } = await db
    .from("clusters")
    .select(
      "id, source_post_id, candidate_result, candidate_usage, evidence_strength",
    )
    .eq("run_id", runId)
    .eq("owner_id", ownerId)
    .in("id", shortlistIds);
  throwDatabaseError(clusterError, "loading generated candidates");
  const rows = clusters || [];
  const generationUsage = aggregateUsage(
    rows.map((cluster) => cluster.candidate_usage),
  );
  let usage = Object.keys(generationUsage).length
    ? mergeUsage(run.usage, "sol_generation", generationUsage)
    : run.usage || {};
  const generated = rows
    .filter(
      (cluster) =>
        cluster.candidate_result?.status === "candidate" &&
        cluster.candidate_result?.selected_idea,
    )
    .map(candidateForDedup)
    .sort(
      (left, right) =>
        right.selected_idea.score - left.selected_idea.score ||
        left.candidate_id.localeCompare(right.candidate_id),
    );
  const counts = {
    ...(run.counts || {}),
    generation_attempted: shortlistIds.length,
    generation_candidates: generated.length,
    generation_no_viable: rows.filter(
      (cluster) => cluster.candidate_result?.status === "no_viable_idea",
    ).length,
    generation_failed: shortlistIds.length - rows.filter(
      (cluster) => cluster.candidate_result,
    ).length,
  };
  if (!generated.length) {
    if (counts.generation_failed > 0) {
      throw new Error("Candidate generation did not complete for every post.");
    }
    await finishWithoutIdeas(db, run, counts, usage);
    return null;
  }

  const embeddingResult = await embedTexts(
    generated.map((candidate) => candidate.fingerprint),
  );
  usage = mergeUsage(usage, "embeddings", embeddingResult.usage);
  const { data: exactMatches, error: exactError } = await db
    .from("ideas")
    .select("fingerprint_hash")
    .eq("owner_id", ownerId)
    .in(
      "fingerprint_hash",
      generated.map((candidate) => candidate.fingerprint_hash),
    );
  throwDatabaseError(exactError, "checking exact candidate duplicates");
  const exactHashes = new Set(
    (exactMatches || []).map((idea) => idea.fingerprint_hash),
  );

  const accepted = [];
  let duplicatesRemoved = 0;
  for (let index = 0; index < generated.length; index += 1) {
    const candidate = generated[index];
    const embedding = embeddingResult.embeddings[index];
    if (
      exactHashes.has(candidate.fingerprint_hash) ||
      duplicatesAcceptedIdea(candidate, embedding, accepted)
    ) {
      duplicatesRemoved += 1;
      continue;
    }
    const { data: matches, error } = await db.rpc("match_ideas", {
      p_owner_id: ownerId,
      p_embedding: embedding,
      p_exclude_run_id: runId,
      p_limit: 8,
    });
    throwDatabaseError(error, "checking semantic candidate duplicates");
    if (
      (matches || []).some((match) =>
        isSemanticIdeaDuplicate(candidate, match, Number(match.similarity)),
      )
    ) {
      duplicatesRemoved += 1;
      continue;
    }
    accepted.push({ ...candidate, embedding });
    exactHashes.add(candidate.fingerprint_hash);
    if (accepted.length >= PIPELINE.maxResearchCandidates) break;
  }

  const finalCounts = {
    ...counts,
    candidate_duplicates_removed: duplicatesRemoved,
    research_candidates: accepted.length,
  };
  if (!accepted.length) {
    await finishWithoutIdeas(db, run, finalCounts, usage);
    return null;
  }

  const evidence = await loadIdeationPosts(
    db,
    runId,
    ownerId,
    accepted.map((candidate) => candidate.source_post_id),
  );
  const evidenceById = new Map(evidence.map((post) => [post.post_id, post]));
  const payload = buildResearchJobPayload({
    runId,
    researchAsOf: run.window_end,
    preferences: run.settings_snapshot?.preferences || {},
    candidates: accepted.map((candidate) => {
      const post = evidenceById.get(candidate.source_post_id);
      return {
        candidate_id: candidate.candidate_id,
        source_post: {
          post_id: post.post_id,
          author_id: post.author_id,
          author_username: post.author_username,
          url: post.url,
          x_created_at: post.x_created_at,
          text: post.text,
          context: compactResearchContext(post),
          metrics: post.metrics || {},
        },
        selected_idea: candidate.selected_idea,
      };
    }),
  });
  const payloadHash = hashResearchJson(payload);
  const { data, error } = await db.rpc("persist_research_job", {
    p_owner_id: ownerId,
    p_run_id: runId,
    p_schema_version: PIPELINE.research.schemaVersion,
    p_prompt_version: PIPELINE.research.promptVersion,
    p_payload: payload,
    p_payload_hash: payloadHash,
    p_counts: { ...finalCounts, research_jobs_queued: 1 },
    p_usage: usage,
  });
  throwDatabaseError(error, "persisting the candidate research job");
  const jobId = data?.[0]?.research_job_id;
  if (!UUID_PATTERN.test(jobId || "")) {
    throw new Error("The candidate research checkpoint did not return a job ID.");
  }
  return jobId;
}
prepareCandidateResearchJob.maxRetries = 3;
