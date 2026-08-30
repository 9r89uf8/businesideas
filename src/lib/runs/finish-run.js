import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const RUN_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "no_ideas",
  "failed",
]);
const RUN_STAGES = new Set([
  "fetching",
  "extracting",
  "clustering",
  "generating",
  "research_queued",
  "researching",
  "validating",
  "saving",
]);
const TERMINAL_STATUSES = new Set(["completed", "no_ideas", "failed"]);
const SAFE_FAILURE_MESSAGE =
  "The research run failed. Review the workflow logs for technical details.";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeRunJson(current, patch) {
  const base = isPlainObject(current) ? current : {};

  if (patch === undefined) {
    return { ...base };
  }

  if (!isPlainObject(patch)) {
    throw new TypeError("Run JSON updates must be objects.");
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] =
      isPlainObject(value) && isPlainObject(base[key])
        ? mergeRunJson(base[key], value)
        : value;
  }

  return merged;
}

function requireIdentity(runId, ownerId) {
  const resolvedRunId = typeof runId === "string" ? runId.trim() : "";
  const resolvedOwnerId =
    typeof ownerId === "string" ? ownerId.trim() : "";

  if (!resolvedRunId || !resolvedOwnerId) {
    throw new TypeError("runId and ownerId are required.");
  }

  return { runId: resolvedRunId, ownerId: resolvedOwnerId };
}

async function loadRun(admin, runId, ownerId) {
  const { data, error } = await admin
    .from("runs")
    .select("id, status, stage, counts, usage, started_at, completed_at")
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error || !data) {
    throw new Error("The research run could not be loaded.");
  }

  return data;
}

/**
 * Owner-scoped run update that merges, rather than replaces, counts and usage.
 */
export async function updateRun({
  runId,
  ownerId = process.env.OWNER_USER_ID,
  status,
  stage,
  counts,
  usage,
} = {}) {
  const identity = requireIdentity(runId, ownerId);

  if (status !== undefined && !RUN_STATUSES.has(status)) {
    throw new TypeError("Invalid run status.");
  }
  if (stage !== undefined && stage !== null && !RUN_STAGES.has(stage)) {
    throw new TypeError("Invalid run stage.");
  }

  const admin = createSupabaseAdminClient();
  const current = await loadRun(admin, identity.runId, identity.ownerId);

  if (
    TERMINAL_STATUSES.has(current.status) &&
    status !== undefined &&
    status !== current.status
  ) {
    throw new Error("The research run has already finished.");
  }

  const now = new Date().toISOString();
  const nextStatus = status ?? current.status;
  const patch = {
    counts: mergeRunJson(current.counts, counts),
    usage: mergeRunJson(current.usage, usage),
  };

  if (status !== undefined) {
    patch.status = status;
  }
  if (stage !== undefined) {
    patch.stage = stage;
  }
  if (nextStatus === "running" && !current.started_at) {
    patch.started_at = now;
  }
  if (TERMINAL_STATUSES.has(nextStatus)) {
    patch.completed_at = current.completed_at ?? now;
    if (nextStatus === "failed") {
      patch.error_message = SAFE_FAILURE_MESSAGE;
    } else {
      patch.error_message = null;
    }
  }

  const { data, error } = await admin
    .from("runs")
    .update(patch)
    .eq("id", identity.runId)
    .eq("owner_id", identity.ownerId)
    .select(
      "id, status, stage, counts, usage, error_message, started_at, completed_at",
    )
    .maybeSingle();

  if (error || !data) {
    throw new Error("The research run could not be updated.");
  }

  return data;
}

export async function mergeRunProgress({
  runId,
  ownerId = process.env.OWNER_USER_ID,
  status = "running",
  stage,
  counts,
  usage,
} = {}) {
  return updateRun({ runId, ownerId, status, stage, counts, usage });
}

export async function completeRun({
  runId,
  ownerId = process.env.OWNER_USER_ID,
  counts,
  usage,
} = {}) {
  return updateRun({
    runId,
    ownerId,
    status: "completed",
    stage: null,
    counts,
    usage,
  });
}

export async function completeWithoutIdeas({
  runId,
  ownerId = process.env.OWNER_USER_ID,
  counts,
  usage,
} = {}) {
  return updateRun({
    runId,
    ownerId,
    status: "no_ideas",
    stage: null,
    counts,
    usage,
  });
}

export async function failRun({
  runId,
  ownerId = process.env.OWNER_USER_ID,
  counts,
  usage,
} = {}) {
  return updateRun({
    runId,
    ownerId,
    status: "failed",
    counts,
    usage,
  });
}
