import { PIPELINE } from "../config.js";
import { fingerprintIdea } from "../fingerprints.js";
import { buildResearchJobPayload } from "../prompts/generate-ideas.js";
import { hashResearchJson } from "../research/canonical-json.js";
import { validateResearchResult } from "../validation.js";
import { cloudPublicationRows, cloudRunUsage } from "./publication.js";
import {
  CLOUD_TERMINAL_STATUSES, automaticCloudShortlist, cloneBoundedJson,
  cloudCandidateForDedup, cloudCandidatePayload, cloudResearchPayload, cloudShortlistPayload,
  emptyCloudReport, requireCloudRunArgs, selectCloudCandidates,
  validateCloudCandidate, validateCloudResearch, validateCloudShortlist,
} from "./contracts.js";

const ACTIVE = ["pending", "running"];
const WAITING_JOBS = ["pending", "claimed", "submitted"];
const TERMINAL_JOBS = new Set(["completed", "failed"]);
const DEADLINE_MESSAGE = "Cloud ideation exceeded its 24-hour deadline.";
const FAILURE_MESSAGE = "Cloud ideation could not be completed.";

function check(error, operation) {
  if (error) throw new Error(`Cloud comparison could not ${operation}.`, { cause: error });
}

function embeddingUsage(previous, usage) {
  return { embeddings: { input_tokens: (Number(previous?.embeddings?.input_tokens) || 0) + (Number(usage?.input_tokens) || 0) } };
}

function resultWithoutEmbedding(idea) {
  const { embedding: _embedding, ...result } = idea;
  return result;
}

// Dependencies are explicit so state transitions can be verified without any
// database credentials or model calls. Primary publication is an atomic RPC;
// shadow runs cannot enter that branch.
export function createCloudIdeationService({ db, embedTexts, now = () => new Date() }) {
  const timestamp = () => now().toISOString();

  async function loadRun(runId, ownerId) {
    const { data, error } = await db.from("cloud_ideation_runs").select("*")
      .eq("id", runId).eq("owner_id", ownerId).maybeSingle();
    check(error, "load its saved run");
    if (data && !["shadow", "primary"].includes(data.mode)) throw new Error("The cloud ideation mode is unsupported.");
    return data;
  }

  async function loadJobs(run) {
    const { data, error } = await db.from("cloud_model_jobs").select("*")
      .eq("cloud_run_id", run.id).eq("owner_id", run.owner_id).order("created_at", { ascending: true });
    check(error, "load its model jobs");
    return data || [];
  }

  async function updateRun(run, values, { onlyEmptyResult = false } = {}) {
    let query = db.from("cloud_ideation_runs")
      .update({ ...values, updated_at: timestamp() })
      .eq("id", run.id).eq("owner_id", run.owner_id).eq("mode", run.mode)
      .in("status", ACTIVE).eq("phase", run.phase);
    if (onlyEmptyResult) query = query.is("result", null);
    const { data, error } = await query.select("*").maybeSingle();
    check(error, "save its progress");
    return data || loadRun(run.id, run.owner_id);
  }

  async function stopWaitingJobs(run, message) {
    const { error } = await db.from("cloud_model_jobs")
      .update({ status: "failed", error_message: message, completed_at: timestamp(), updated_at: timestamp() })
      .eq("cloud_run_id", run.id).eq("owner_id", run.owner_id).in("status", WAITING_JOBS);
    check(error, "close unfinished model jobs");
  }

  async function finish(run, report, status = report.ideas.length ? "completed" : "no_ideas") {
    if (run.mode === "primary") {
      if (status !== "no_ideas" || report.ideas.length) throw new Error("Primary ideas require atomic publication.");
      const jobs = await loadJobs(run);
      const { data, error } = await db.rpc("finish_primary_cloud_ideation", {
        p_owner_id: run.owner_id, p_run_id: run.id,
        p_report: { ...report, mode: "primary", usage: cloudRunUsage(jobs, report.usage) },
        p_error_message: null,
      });
      check(error, "complete its primary run");
      const saved = data?.[0];
      if (!saved || !CLOUD_TERMINAL_STATUSES.has(saved.status)) throw new Error("The primary completion checkpoint is incomplete.");
      await stopWaitingJobs(saved, "Cloud ideation has already finished.");
      return saved;
    }
    const saved = await updateRun(run, {
      status, phase: "done", result: report, error_message: null, completed_at: timestamp(),
    });
    if (saved && CLOUD_TERMINAL_STATUSES.has(saved.status)) {
      await stopWaitingJobs(saved, "Cloud comparison has already finished.");
    }
    return saved;
  }

  async function failCloudIdeationRun({ runId, ownerId, message }) {
    requireCloudRunArgs({ runId, ownerId });
    const run = await loadRun(runId, ownerId);
    if (!run) return { id: runId, status: "failed", phase: "done" };
    const safeMessage = message === DEADLINE_MESSAGE ? DEADLINE_MESSAGE : FAILURE_MESSAGE;
    let saved = run;
    if (!CLOUD_TERMINAL_STATUSES.has(run.status)) {
      if (run.mode === "primary") {
        const jobs = await loadJobs(run);
        const report = emptyCloudReport(safeMessage, run.result || {}, run.mode);
        report.usage = cloudRunUsage(jobs, report.usage);
        const { data, error } = await db.rpc("finish_primary_cloud_ideation", {
          p_owner_id: ownerId, p_run_id: runId, p_report: report, p_error_message: safeMessage,
        });
        check(error, "record its primary failure");
        saved = data?.[0];
        if (!saved || !CLOUD_TERMINAL_STATUSES.has(saved.status)) throw new Error("The primary failure checkpoint is incomplete.");
      } else {
        saved = await updateRun(run, { status: "failed", phase: "done", error_message: safeMessage, completed_at: timestamp() });
      }
    }
    // The run status also gates queue claims, including while this cleanup retries.
    if (saved && CLOUD_TERMINAL_STATUSES.has(saved.status)) await stopWaitingJobs(saved, safeMessage);
    return saved;
  }

  async function enqueue(run, kind, jobKey, payload, sourcePostId = null) {
    // The cloud worker explicitly starts a fresh Sol High child for every kind.
    const requestedReasoning = PIPELINE.reasoning.generation;
    const { error } = await db.from("cloud_model_jobs").upsert({
      cloud_run_id: run.id, owner_id: run.owner_id, job_key: jobKey,
      kind, source_post_id: sourcePostId, payload, status: "pending",
      requested_model: PIPELINE.models.generation, requested_reasoning: requestedReasoning,
      runtime_metadata: { model_verified: false },
    }, { onConflict: "cloud_run_id,job_key", ignoreDuplicates: true });
    check(error, "enqueue its model job");
  }

  async function completeJob(run, job, validator) {
    if (job.status === "failed") return job;
    if (!["submitted", "completed"].includes(job.status)) return job;
    let valid;
    try { valid = validator(job.result); } catch {
      if (job.status === "completed") throw new Error("A completed cloud response failed its contract.");
      const message = `The cloud ${job.kind} response did not match its required contract.`;
      const { error } = await db.from("cloud_model_jobs")
        .update({ status: "failed", error_message: message, completed_at: timestamp(), updated_at: timestamp() })
        .eq("id", job.id).eq("owner_id", run.owner_id).eq("cloud_run_id", run.id).eq("status", "submitted");
      check(error, "record an invalid model response");
      return { ...job, status: "failed", error_message: message };
    }
    if (job.status === "submitted") {
      const { error } = await db.from("cloud_model_jobs")
        .update({ status: "completed", completed_at: timestamp(), updated_at: timestamp() })
        .eq("id", job.id).eq("owner_id", run.owner_id).eq("cloud_run_id", run.id).eq("status", "submitted");
      check(error, "complete a validated model job");
    }
    // Store the original response unchanged; normalized values are used locally.
    return { ...job, status: "completed", result: valid };
  }

  async function loadHistory(run) {
    const history = [];
    const pageSize = 200;
    for (let offset = 0; offset < 10_000; offset += pageSize) {
      let query = db.from("ideas")
        .select("id, target_customer, problem, fingerprint_hash, embedding")
        .eq("owner_id", run.owner_id).neq("run_id", run.id);
      // Comparisons use the source run's historical universe; authoritative
      // publication must also catch ideas saved while the cloud worker ran.
      if (run.mode === "shadow") query = query.lt("created_at", run.input.history_cutoff);
      const { data, error } = await query.order("id", { ascending: true }).range(offset, offset + pageSize - 1);
      check(error, "read historical duplicate evidence");
      history.push(...(data || []));
      if ((data || []).length < pageSize) return history;
    }
    throw new Error("Cloud historical comparison exceeded its bounded input limit.");
  }

  async function createCloudIdeationRun({ runId, ownerId, survivorPostIds, mode = "shadow" }) {
    requireCloudRunArgs({ runId, ownerId });
    if (!["shadow", "primary"].includes(mode)) throw new TypeError("The cloud ideation mode is unsupported.");
    const existing = await loadRun(runId, ownerId);
    if (existing) {
      if (existing.mode !== mode) throw new Error("The saved cloud mode cannot be changed.");
      return existing;
    }
    if (!Array.isArray(survivorPostIds) || survivorPostIds.length > PIPELINE.maxForYouInput ||
      new Set(survivorPostIds).size !== survivorPostIds.length || survivorPostIds.some((id) => typeof id !== "string" || !/^\d{1,32}$/.test(id))) {
      throw new TypeError("Cloud comparison requires at most thirty distinct source posts.");
    }
    const { data: sourceRun, error: sourceError } = await db.from("runs")
      .select("id, status, settings_snapshot, window_end, started_at, created_at")
      .eq("id", runId).eq("owner_id", ownerId).maybeSingle();
    check(sourceError, "read its source run");
    if (!sourceRun) throw new Error("The source run does not belong to this owner.");
    if (mode === "primary" && (sourceRun.settings_snapshot?.ideation_provider !== "chatgpt_cloud" || !["queued", "running"].includes(sourceRun.status))) {
      throw new Error("Primary cloud ideation requires an active cloud-provider source run.");
    }
    let posts = [];
    if (survivorPostIds.length) {
      const [snapshots, originals] = await Promise.all([
        db.from("run_posts").select("post_id, selected_for_ai, filter_decision, filter_reason, commercial_element, hydrated_context, metrics, signal_type, signal_summary, problem")
          .eq("run_id", runId).eq("owner_id", ownerId).in("post_id", survivorPostIds),
        db.from("posts").select("x_post_id, author_id, author_username, text, url, x_created_at, availability")
          .eq("owner_id", ownerId).in("x_post_id", survivorPostIds),
      ]);
      check(snapshots.error, "read its source snapshots");
      check(originals.error, "read its retained source posts");
      const snapshotMap = new Map((snapshots.data || []).map((post) => [post.post_id, post]));
      const originalMap = new Map((originals.data || []).map((post) => [post.x_post_id, post]));
      posts = survivorPostIds.map((id) => {
        const snapshot = snapshotMap.get(id);
        const original = originalMap.get(id);
        if (!snapshot?.selected_for_ai ||
          !(snapshot.filter_decision === "keep" || (snapshot.filter_decision === "needs_context" && snapshot.hydrated_context?.status === "resolved")) ||
          !original?.text?.trim() || !original.author_id || (original.availability && original.availability !== "available")) {
          throw new Error("A cloud source post is unavailable or did not survive the source filter.");
        }
        return {
          post_id: id, author_id: original.author_id, author_username: original.author_username,
          text: original.text, url: original.url, x_created_at: original.x_created_at,
          metrics: snapshot.metrics || {}, filter_reason: snapshot.filter_reason || "",
          commercial_element: snapshot.commercial_element || "none",
          context_summary: snapshot.hydrated_context?.context_summary || "",
          context: snapshot.hydrated_context || null,
          signal_type: snapshot.signal_type || null, signal_summary: snapshot.signal_summary || "", problem: snapshot.problem || "",
        };
      });
    }
    const preferences = sourceRun.settings_snapshot?.preferences || {};
    // Apply the same bounded prompt builders before storing any input.
    for (const post of posts) cloudCandidatePayload(post, preferences);
    if (posts.length > PIPELINE.maxShortlistedPosts) cloudShortlistPayload(posts);
    const input = cloneBoundedJson({
      schema_version: 1, source_run_id: runId, posts, preferences,
      research_as_of: sourceRun.window_end,
      history_cutoff: sourceRun.started_at || sourceRun.created_at || timestamp(),
    }, 1024 * 1024);
    const automatic = posts.length <= PIPELINE.maxShortlistedPosts;
    const { error } = await db.from("cloud_ideation_runs").upsert({
      id: runId, owner_id: ownerId, mode, input,
      status: posts.length || mode === "primary" ? "pending" : "no_ideas",
      phase: posts.length || mode === "primary" ? (automatic ? "generating" : "shortlist") : "done",
      shortlist_result: automatic ? automaticCloudShortlist(posts) : null,
      result: posts.length || mode === "primary" ? null : emptyCloudReport("No posts survived the shared Luna stages.", {}, mode),
      completed_at: posts.length || mode === "primary" ? null : timestamp(),
    }, { onConflict: "id", ignoreDuplicates: true });
    check(error, "save its immutable input");
    const saved = await loadRun(runId, ownerId);
    if (!saved || saved.mode !== mode) throw new Error("The saved cloud mode cannot be changed.");
    return saved;
  }

  async function advanceShortlist(run, jobs) {
    await enqueue(run, "shortlist", "shortlist", cloudShortlistPayload(run.input.posts));
    const job = jobs.find((item) => item.job_key === "shortlist" && item.kind === "shortlist");
    if (!job) return updateRun(run, { status: "running" });
    const checked = await completeJob(run, job, (value) => validateCloudShortlist(value, run.input.posts));
    if (checked.status === "failed") return failCloudIdeationRun({ runId: run.id, ownerId: run.owner_id });
    if (checked.status !== "completed") return updateRun(run, { status: "running" });
    if (!checked.result.advanced_post_ids.length) {
      const saved = await updateRun(run, { shortlist_result: checked.result });
      return finish(saved, emptyCloudReport("Cloud shortlisting advanced no posts.", {
        counts: { shortlist_survivors: run.input.posts.length, shortlisted_posts: 0, shortlist_skipped: false },
      }, run.mode));
    }
    return updateRun(run, { status: "running", phase: "generating", shortlist_result: checked.result });
  }

  async function advanceGeneration(run, jobs) {
    const advancedIds = run.shortlist_result?.advanced_post_ids;
    if (!Array.isArray(advancedIds) || !advancedIds.length || advancedIds.length > PIPELINE.maxShortlistedPosts || new Set(advancedIds).size !== advancedIds.length) {
      throw new Error("The cloud shortlist checkpoint is invalid.");
    }
    const postMap = new Map(run.input.posts.map((post) => [post.post_id, post]));
    if (advancedIds.some((id) => !postMap.has(id))) throw new Error("The cloud shortlist contains an unknown source post.");
    for (const id of advancedIds) await enqueue(run, "candidate", `candidate:${id}`, cloudCandidatePayload(postMap.get(id), run.input.preferences), id);
    const selectedJobs = [];
    for (const id of advancedIds) {
      const job = jobs.find((item) => item.job_key === `candidate:${id}` && item.kind === "candidate" && item.source_post_id === id);
      if (!job) return updateRun(run, { status: "running" });
      selectedJobs.push(await completeJob(run, job, (value) => validateCloudCandidate(value, id)));
    }
    if (selectedJobs.some((job) => !TERMINAL_JOBS.has(job.status))) return updateRun(run, { status: "running" });
    const generated = selectedJobs.filter((job) => job.status === "completed" && job.result.status === "candidate")
      .map(cloudCandidateForDedup).sort((a, b) => b.selected_idea.score - a.selected_idea.score || a.candidate_id.localeCompare(b.candidate_id));
    const rejected = selectedJobs.filter((job) => job.status === "failed" || job.result?.status === "no_viable_idea")
      .map((job) => ({ stage: "generation", candidate_id: job.id, source_post_id: job.source_post_id, reason_codes: [job.status === "failed" ? "generation_failed" : "no_viable_idea"] }));
    const counts = {
      shortlist_survivors: run.input.posts.length, shortlist_skipped: Boolean(run.shortlist_result?.automatic),
      shortlisted_posts: advancedIds.length, generation_candidates: generated.length,
      generation_no_viable: selectedJobs.filter((job) => job.result?.status === "no_viable_idea").length,
      generation_failed: selectedJobs.filter((job) => job.status === "failed").length,
    };
    if (!generated.length) {
      const report = emptyCloudReport("No cloud-generated candidates remain.", { rejected, counts }, run.mode);
      if (counts.generation_failed) {
        const saved = await updateRun(run, { result: report });
        return failCloudIdeationRun({ runId: saved.id, ownerId: saved.owner_id });
      }
      return finish(run, report);
    }
    let report = run.result;
    if (!Array.isArray(report?.research_candidate_ids)) {
      const [embeddingResult, history] = await Promise.all([embedTexts(generated.map((idea) => idea.fingerprint)), loadHistory(run)]);
      const selection = selectCloudCandidates(generated, embeddingResult.embeddings, history);
      report = emptyCloudReport("Cloud candidates are awaiting research.", {
        rejected: [...rejected, ...selection.rejected.map((item) => ({ stage: "pre_research", ...item }))],
        counts: { ...counts, research_candidates: selection.accepted.length },
        usage: embeddingUsage(null, embeddingResult.usage),
        research_candidate_ids: selection.accepted.map((idea) => idea.candidate_id),
      }, run.mode);
      // Persist expensive trusted selection before enqueueing, so recovery does
      // not regenerate embeddings or silently change the research input.
      run = await updateRun(run, { result: report }, { onlyEmptyResult: true });
      if (run.phase !== "generating" || CLOUD_TERMINAL_STATUSES.has(run.status)) return run;
      report = run.result;
    }
    const accepted = report.research_candidate_ids.map((id) => generated.find((idea) => idea.candidate_id === id));
    if (accepted.some((idea) => !idea)) throw new Error("The cloud candidate selection checkpoint is invalid.");
    if (!accepted.length) return finish(run, { ...report, assessment: { overall_evidence: "insufficient", notes: "Cloud candidates were removed by trusted deduplication." } });
    const payload = buildResearchJobPayload({
      runId: run.id, researchAsOf: run.input.research_as_of, preferences: run.input.preferences,
      candidates: accepted.map((candidate) => ({
        candidate_id: candidate.candidate_id, source_post: postMap.get(candidate.source_post_id), selected_idea: candidate.selected_idea,
      })),
    });
    await enqueue(run, "research", "research", cloudResearchPayload(payload));
    return updateRun(run, { status: "running", phase: "researching" });
  }

  async function advanceResearch(run, jobs) {
    const job = jobs.find((item) => item.job_key === "research" && item.kind === "research");
    if (!job) throw new Error("The cloud research checkpoint is incomplete.");
    const payload = job.payload?.input;
    const selectedIds = run.result?.research_candidate_ids;
    const sourcePosts = new Map(run.input.posts.map((post) => [post.post_id, post]));
    if (payload?.run_id !== run.id || !Array.isArray(payload?.candidates) ||
      !Array.isArray(selectedIds) || payload.candidates.length !== selectedIds.length ||
      new Set(payload.candidates.map((candidate) => candidate.candidate_id)).size !== selectedIds.length ||
      payload.candidates.some((candidate) => {
        const generation = jobs.find((item) => item.id === candidate.candidate_id && item.kind === "candidate" && item.status === "completed");
        const source = sourcePosts.get(candidate.source_post?.post_id);
        return !selectedIds.includes(candidate.candidate_id) || !generation || !source ||
          generation.source_post_id !== source.post_id || candidate.source_post.text !== source.text ||
          candidate.source_post.author_id !== source.author_id;
      })) {
      throw new Error("The cloud research payload does not match its selected candidates.");
    }
    const checked = await completeJob(run, job, (value) => validateCloudResearch(value, payload));
    if (checked.status === "failed") return failCloudIdeationRun({ runId: run.id, ownerId: run.owner_id });
    if (checked.status !== "completed") return run;
    if (run.phase !== "validating") {
      run = await updateRun(run, { status: "running", phase: "validating" });
      if (run.phase !== "validating" || CLOUD_TERMINAL_STATUSES.has(run.status)) return run;
    }
    const validated = validateResearchResult(checked.result, payload, run.input.posts);
    const grounded = validated.ideas.filter((idea) => idea.publishable).map((idea) => ({ ...idea, ...fingerprintIdea(idea) }));
    const [embeddingResult, history] = await Promise.all([embedTexts(grounded.map((idea) => idea.fingerprint)), loadHistory(run)]);
    const selection = selectCloudCandidates(grounded, embeddingResult.embeddings, history, PIPELINE.maxPublishedIdeas);
    const rejected = [...(run.result?.rejected || [])];
    const returned = new Set(checked.result.ideas.map((idea) => idea.candidate_id));
    const assessed = new Map(validated.ideas.map((idea) => [idea.candidate_id, idea]));
    for (const candidate of payload.candidates) {
      const idea = assessed.get(candidate.candidate_id);
      const reasons = !returned.has(candidate.candidate_id) ? ["research_omitted"] : !idea ? ["invalid_grounding"] : idea.validation_errors;
      if (reasons?.length) rejected.push({ stage: "research", candidate_id: candidate.candidate_id, source_post_id: candidate.source_post.post_id, reason_codes: reasons });
    }
    rejected.push(...selection.rejected.map((item) => ({ stage: "final_deduplication", ...item })));
    const ideas = selection.accepted.map((idea, index) => ({ ...resultWithoutEmbedding(idea), rank: index + 1 }));
    const report = emptyCloudReport("", {
      assessment: validated.assessment, ideas, sources: validated.sources, rejected,
      counts: {
        ...(run.result?.counts || {}), candidates_researched: payload.candidates.length,
        candidates_validated: grounded.length, duplicates_removed: selection.rejected.length,
        ...(run.mode === "shadow" ? { shadow_ideas: ideas.length } : { ideas_saved: ideas.length }),
      },
      usage: embeddingUsage(run.result?.usage, embeddingResult.usage),
      research_candidate_ids: run.result?.research_candidate_ids || [],
    }, run.mode);
    if (run.mode === "primary") {
      const rows = cloudPublicationRows({ accepted: selection.accepted, sources: validated.sources, payload, posts: run.input.posts });
      // Hash the immutable worker response, not its locally normalized copy.
      // The RPC atomically bridges the completed cloud job into the existing
      // publisher and stamps actual idea IDs before making either run terminal.
      const usage = cloudRunUsage(jobs.map((item) => item.id === checked.id ? checked : item), report.usage);
      const { data, error } = await db.rpc("publish_primary_cloud_ideas", {
        p_owner_id: run.owner_id, p_run_id: run.id, p_cloud_job_id: job.id,
        p_payload_hash: hashResearchJson(payload), p_result_hash: hashResearchJson(job.result),
        p_ideas: rows.ideas, p_x_sources: rows.xSources,
        p_research_sources: rows.researchSources, p_idea_research_sources: rows.ideaResearchSources,
        p_counts: report.counts, p_usage: usage, p_report: { ...report, usage },
      });
      check(error, "publish its primary ideas");
      const saved = data?.[0];
      if (!saved || !CLOUD_TERMINAL_STATUSES.has(saved.status)) throw new Error("The primary publication checkpoint is incomplete.");
      await stopWaitingJobs(saved, "Cloud ideation has already finished.");
      return saved;
    }
    return finish(run, report);
  }

  async function advanceCloudIdeationRun({ runId, ownerId }) {
    requireCloudRunArgs({ runId, ownerId });
    const run = await loadRun(runId, ownerId);
    if (!run) throw new Error("The cloud comparison run was not found.");
    if (CLOUD_TERMINAL_STATUSES.has(run.status)) {
      await stopWaitingJobs(run, "Cloud comparison has already finished.");
      return run;
    }
    if (!Number.isFinite(Date.parse(run.deadline_at)) || now().getTime() >= Date.parse(run.deadline_at)) {
      return failCloudIdeationRun({ runId, ownerId, message: DEADLINE_MESSAGE });
    }
    if (!Array.isArray(run.input?.posts) || run.input.source_run_id !== run.id) {
      throw new Error("The immutable cloud input is invalid.");
    }
    if (!run.input.posts.length) {
      return finish(run, emptyCloudReport("No posts survived the shared Luna stages.", {}, run.mode));
    }
    const jobs = await loadJobs(run);
    if (run.phase === "shortlist") return advanceShortlist(run, jobs);
    if (run.phase === "generating") return advanceGeneration(run, jobs);
    if (["researching", "validating"].includes(run.phase)) return advanceResearch(run, jobs);
    throw new Error("The cloud comparison phase is unsupported.");
  }

  return { createCloudIdeationRun, advanceCloudIdeationRun, failCloudIdeationRun };
}
