import "server-only";

import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { DEFAULT_PREFERENCES, DEFAULT_X_QUERY, PIPELINE } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  getRecentSearchWindow,
  normalizeFollowedUsernames,
} from "@/lib/x/search-posts";
import { dailyResearch } from "@/workflows/daily-research";

const ACTIVE_RUN_STATUSES = ["queued", "running"];
const STALE_RUN_AGE_MS = 6 * 60 * 60 * 1_000;
const STALE_RUN_MESSAGE =
  "This run was stopped after remaining active for more than six hours.";
const DISPATCH_FAILURE_MESSAGE =
  "The research workflow could not be started.";
const RUN_SELECT =
  "id, status, stage, counts, error_message, window_start, window_end";

export const RUN_START_OUTCOMES = Object.freeze({
  STARTED: "started",
  RETRIED: "retried",
  ALREADY_FINISHED: "already_finished",
});

export class ActiveRunError extends Error {
  constructor() {
    super("A research run is already active.");
    this.name = "ActiveRunError";
    this.code = "ACTIVE_RUN";
  }
}

function requireOwnerId(ownerId) {
  const value = typeof ownerId === "string" ? ownerId.trim() : "";

  if (!value) {
    throw new Error("The application owner is not configured.");
  }

  return value;
}

function normalizeInteger(value, fallback, minimum, maximum) {
  if (!Number.isInteger(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(value, maximum));
}

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

export function buildEffectiveSettings(settings) {
  const preferences = settings?.preferences;

  return {
    x_query:
      typeof settings?.x_query === "string" && settings.x_query.trim()
        ? settings.x_query.trim()
        : DEFAULT_X_QUERY,
    candidate_limit: normalizeInteger(
      settings?.candidate_limit,
      PIPELINE.maxCandidates,
      50,
      PIPELINE.maxCandidates,
    ),
    ai_input_limit: normalizeInteger(
      settings?.ai_input_limit,
      PIPELINE.defaultAiInputLimit,
      25,
      PIPELINE.defaultAiInputLimit,
    ),
    followed_x_usernames: normalizeFollowedUsernames(
      settings?.followed_x_usernames,
    ),
    preferences: {
      offer_bias:
        typeof preferences?.offer_bias === "string" &&
        preferences.offer_bias.trim()
          ? preferences.offer_bias.trim()
          : DEFAULT_PREFERENCES.offer_bias,
      preferred_customers: normalizeStringList(
        preferences?.preferred_customers,
        DEFAULT_PREFERENCES.preferred_customers,
      ),
      preferred_business_models: normalizeStringList(
        preferences?.preferred_business_models,
        DEFAULT_PREFERENCES.preferred_business_models,
      ),
      avoid: normalizeStringList(
        preferences?.avoid,
        DEFAULT_PREFERENCES.avoid,
      ),
      personal_advantages: normalizeStringList(
        preferences?.personal_advantages,
        DEFAULT_PREFERENCES.personal_advantages,
      ),
    },
  };
}

export function createRunKey(trigger, now = new Date()) {
  if (trigger === "scheduled") {
    return `scheduled:${now.toISOString().slice(0, 10)}`;
  }

  if (trigger === "manual") {
    return `manual:${randomUUID()}`;
  }

  throw new TypeError("trigger must be scheduled or manual.");
}

export function isStaleRun(run, nowMs = Date.now()) {
  if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) {
    return false;
  }

  const referenceValue =
    run.status === "running"
      ? run.started_at || run.created_at
      : run.created_at;
  const referenceMs = Date.parse(referenceValue);

  return (
    Number.isFinite(referenceMs) && nowMs - referenceMs > STALE_RUN_AGE_MS
  );
}

async function expireStaleRuns(admin, ownerId, now) {
  const { data, error } = await admin
    .from("runs")
    .select("id, status, created_at, started_at")
    .eq("owner_id", ownerId)
    .in("status", ACTIVE_RUN_STATUSES);

  if (error) {
    throw new Error("Active research runs could not be checked.");
  }

  const staleIds = (data ?? [])
    .filter((run) => isStaleRun(run, now.getTime()))
    .map((run) => run.id);

  if (staleIds.length === 0) {
    return;
  }

  const { error: updateError } = await admin
    .from("runs")
    .update({
      status: "failed",
      error_message: STALE_RUN_MESSAGE,
      completed_at: now.toISOString(),
    })
    .eq("owner_id", ownerId)
    .in("id", staleIds)
    .in("status", ACTIVE_RUN_STATUSES);

  if (updateError) {
    throw new Error("Stale research runs could not be closed.");
  }
}

async function loadEffectiveSettings(admin, ownerId) {
  const { data, error } = await admin
    .from("settings")
    .select(
      "x_query, candidate_limit, ai_input_limit, followed_x_usernames, preferences",
    )
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    throw new Error("Research settings could not be loaded.");
  }

  return buildEffectiveSettings(data);
}

async function loadPreviousWindowEnd(admin, ownerId) {
  const { data, error } = await admin
    .from("runs")
    .select("window_end")
    .eq("owner_id", ownerId)
    .in("status", ["completed", "no_ideas"])
    .order("window_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("The previous research window could not be loaded.");
  }

  return data?.window_end ?? null;
}

async function markDispatchFailure(admin, runId, ownerId) {
  const { error } = await admin
    .from("runs")
    .update({
      status: "failed",
      error_message: DISPATCH_FAILURE_MESSAGE,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .in("status", ACTIVE_RUN_STATUSES);

  if (error) {
    throw new Error("The failed workflow dispatch could not be recorded.");
  }
}

async function loadRunByKey(admin, ownerId, runKey) {
  const { data, error } = await admin
    .from("runs")
    .select(RUN_SELECT)
    .eq("owner_id", ownerId)
    .eq("run_key", runKey)
    .maybeSingle();

  if (error) {
    throw new Error("The existing scheduled run could not be loaded.");
  }

  return data;
}

async function loadActiveRun(admin, ownerId) {
  const { data, error } = await admin
    .from("runs")
    .select("id, status")
    .eq("owner_id", ownerId)
    .in("status", ACTIVE_RUN_STATUSES)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("The active research run could not be loaded.");
  }

  return data;
}

function withOutcome(run, outcome) {
  return { ...run, outcome };
}

async function resolveScheduledConflict({
  admin,
  ownerId,
  runKey,
  now,
}) {
  const [activeRun, scheduledRun] = await Promise.all([
    loadActiveRun(admin, ownerId),
    loadRunByKey(admin, ownerId, runKey),
  ]);

  if (activeRun) {
    throw new ActiveRunError();
  }

  if (!scheduledRun) {
    throw new Error("The conflicting research run could not be resolved.");
  }

  if (["completed", "no_ideas"].includes(scheduledRun.status)) {
    return {
      dispatch: false,
      run: withOutcome(
        scheduledRun,
        RUN_START_OUTCOMES.ALREADY_FINISHED,
      ),
    };
  }

  if (scheduledRun.status !== "failed") {
    throw new ActiveRunError();
  }

  // Reuse the same scheduled run ID so a cron retry cannot duplicate prior
  // checkpoints. The conditional status match is the retry claim: only one
  // concurrent caller can move this row back to queued.
  const { data: retriedRun, error: retryError } = await admin
    .from("runs")
    .update({
      status: "queued",
      error_message: null,
      completed_at: null,
      started_at: null,
      created_at: now.toISOString(),
    })
    .eq("id", scheduledRun.id)
    .eq("owner_id", ownerId)
    .eq("status", "failed")
    .select(RUN_SELECT)
    .maybeSingle();

  if (retryError?.code === "23505") {
    throw new ActiveRunError();
  }

  if (retryError) {
    throw new Error("The failed scheduled run could not be retried.");
  }

  if (!retriedRun) {
    const currentRun = await loadRunByKey(admin, ownerId, runKey);

    if (["completed", "no_ideas"].includes(currentRun?.status)) {
      return {
        dispatch: false,
        run: withOutcome(
          currentRun,
          RUN_START_OUTCOMES.ALREADY_FINISHED,
        ),
      };
    }

    if (ACTIVE_RUN_STATUSES.includes(currentRun?.status)) {
      throw new ActiveRunError();
    }

    throw new Error("The failed scheduled run could not be claimed.");
  }

  return {
    dispatch: true,
    run: withOutcome(retriedRun, RUN_START_OUTCOMES.RETRIED),
  };
}

export async function startRun({
  ownerId = process.env.OWNER_USER_ID,
  trigger,
} = {}) {
  const resolvedOwnerId = requireOwnerId(ownerId);
  if (trigger !== "scheduled" && trigger !== "manual") {
    throw new TypeError("trigger must be scheduled or manual.");
  }

  const admin = createSupabaseAdminClient();
  const now = new Date();

  await expireStaleRuns(admin, resolvedOwnerId, now);

  const [settingsSnapshot, previousWindowEnd] = await Promise.all([
    loadEffectiveSettings(admin, resolvedOwnerId),
    loadPreviousWindowEnd(admin, resolvedOwnerId),
  ]);
  const window = getRecentSearchWindow({
    previousWindowEnd: previousWindowEnd ?? undefined,
    endTime: now,
  });
  const runKey = createRunKey(trigger, now);
  const insert = {
    owner_id: resolvedOwnerId,
    run_key: runKey,
    trigger,
    status: "queued",
    stage: null,
    window_start: window.startTime,
    window_end: window.endTime,
    settings_snapshot: settingsSnapshot,
    counts: {},
    usage: {},
    error_message: null,
  };
  const { data: run, error: insertError } = await admin
    .from("runs")
    .insert(insert)
    .select(RUN_SELECT)
    .single();

  if (insertError?.code === "23505") {
    if (trigger !== "scheduled") {
      const activeRun = await loadActiveRun(admin, resolvedOwnerId);
      if (activeRun) {
        throw new ActiveRunError();
      }

      throw new Error("The conflicting manual run could not be resolved.");
    }

    const resolved = await resolveScheduledConflict({
      admin,
      ownerId: resolvedOwnerId,
      runKey,
      now,
    });

    if (!resolved.dispatch) {
      return resolved.run;
    }

    try {
      await start(dailyResearch, [
        { runId: resolved.run.id, ownerId: resolvedOwnerId },
      ]);
    } catch {
      await markDispatchFailure(admin, resolved.run.id, resolvedOwnerId);
      throw new Error(DISPATCH_FAILURE_MESSAGE);
    }

    return resolved.run;
  }

  if (insertError || !run?.id) {
    throw new Error("The research run could not be created.");
  }

  try {
    await start(dailyResearch, [
      { runId: run.id, ownerId: resolvedOwnerId },
    ]);
  } catch {
    await markDispatchFailure(admin, run.id, resolvedOwnerId);
    throw new Error(DISPATCH_FAILURE_MESSAGE);
  }

  return withOutcome(run, RUN_START_OUTCOMES.STARTED);
}
