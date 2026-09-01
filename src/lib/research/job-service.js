import "server-only";

import { start } from "workflow/api";
import { PIPELINE } from "@/lib/config";
import { hashResearchJson } from "@/lib/research/canonical-json";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateResearchResultShape } from "@/lib/validation";
import { finalizeResearch } from "@/workflows/finalize-research";

export const RESEARCH_FAILURE_CODES = Object.freeze([
  "research_unavailable",
  "source_access_failed",
  "submission_invalid",
  "tool_error",
]);

export class ResearchJobServiceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ResearchJobServiceError";
  }
}

function serviceError(message, cause) {
  return new ResearchJobServiceError(message, cause ? { cause } : undefined);
}

function validRpcRow(row, keys) {
  return (
    row &&
    typeof row === "object" &&
    !Array.isArray(row) &&
    keys.every((key) => row[key] !== null && row[key] !== undefined)
  );
}

function encodedJsonBytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapResearchJobState(row) {
  if (!row) return null;
  return {
    jobId: row.id,
    runId: row.run_id,
    status: row.status,
    schemaVersion: row.schema_version,
    promptVersion: row.prompt_version,
    payloadHash: row.payload_hash,
    resultHash: row.result_hash,
    claimId: row.claim_id,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    submittedAt: row.submitted_at,
    validationStartedAt: row.validation_started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    lastErrorCode: row.last_error_code,
  };
}

async function dispatchResearchFinalizer({ ownerId, jobId }, errorMessage) {
  try {
    await start(finalizeResearch, [{ jobId, ownerId }]);
  } catch (error) {
    throw serviceError(errorMessage, error);
  }
}

async function mergeRunUsagePatch(db, { ownerId, runId, usage }) {
  if (usage === undefined) return;
  if (!isJsonObject(usage) || encodedJsonBytes(usage) > 65_536) {
    throw serviceError("The research usage does not match the required shape.");
  }

  const { data: run, error: loadError } = await db
    .from("runs")
    .select("usage")
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (loadError || !run || !isJsonObject(run.usage)) {
    throw serviceError(
      "The result was saved, but usage could not be recorded. Retry this same submission.",
      loadError,
    );
  }

  // The caller supplies a top-level usage patch. Assigning its keys makes a
  // replay idempotent; token values must never be added a second time.
  const mergedUsage = { ...run.usage, ...usage };
  if (hashResearchJson(mergedUsage) === hashResearchJson(run.usage)) return;

  const { data: updatedRun, error: updateError } = await db
    .from("runs")
    .update({ usage: mergedUsage })
    .eq("id", runId)
    .eq("owner_id", ownerId)
    .select("id")
    .maybeSingle();
  if (updateError || !updatedRun) {
    throw serviceError(
      "The result was saved, but usage could not be recorded. Retry this same submission.",
      updateError,
    );
  }
}

export async function getResearchJobState({ ownerId, jobId }) {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("research_jobs")
      .select(
        "id, run_id, status, schema_version, prompt_version, payload_hash, result_hash, claim_id, lease_expires_at, attempt_count, available_at, created_at, updated_at, claimed_at, submitted_at, validation_started_at, completed_at, failed_at, last_error_code",
      )
      .eq("id", jobId)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (error) {
      throw serviceError("Research job state could not be loaded.", error);
    }
    return mapResearchJobState(data);
  } catch (error) {
    if (error instanceof ResearchJobServiceError) throw error;
    throw serviceError("Research job state could not be loaded.", error);
  }
}

export async function redriveStrandedResearchFinalization(ownerId) {
  try {
    const staleValidationBefore = new Date(
      Date.now() - PIPELINE.research.validationRedriveSeconds * 1_000,
    ).toISOString();
    const { data, error } = await createSupabaseAdminClient()
      .from("research_jobs")
      .select(
        "id, run_id, status, schema_version, prompt_version, payload_hash, result_hash, claim_id, lease_expires_at, attempt_count, available_at, created_at, updated_at, claimed_at, submitted_at, validation_started_at, completed_at, failed_at, last_error_code",
      )
      .eq("owner_id", ownerId)
      .or(
        `and(status.eq.submitted,submitted_at.lt.${staleValidationBefore}),and(status.eq.validating,validation_started_at.lt.${staleValidationBefore})`,
      )
      .order("submitted_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw serviceError(
        "Pending research finalization could not be checked.",
        error,
      );
    }
    if (!data) return null;

    await dispatchResearchFinalizer(
      { jobId: data.id, ownerId },
      "Pending research finalization could not be restarted.",
    );
    return mapResearchJobState(data);
  } catch (error) {
    if (error instanceof ResearchJobServiceError) throw error;
    throw serviceError(
      "Pending research finalization could not be checked.",
      error,
    );
  }
}

export async function claimResearchJobForOwner(ownerId) {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .rpc("claim_pending_research_job", {
        p_owner_id: ownerId,
        p_lease_seconds: PIPELINE.research.leaseSeconds,
      })
      .maybeSingle();

    if (error) {
      throw serviceError("A research job could not be claimed.", error);
    }
    if (!data) return null;

    const required = [
      "research_job_id",
      "run_id",
      "schema_version",
      "prompt_version",
      "job_payload",
      "payload_hash",
      "claim_id",
      "lease_expires_at",
      "attempt_count",
    ];
    if (!validRpcRow(data, required)) {
      throw serviceError("The claimed research job was incomplete.");
    }

    return {
      jobId: data.research_job_id,
      runId: data.run_id,
      schemaVersion: data.schema_version,
      promptVersion: data.prompt_version,
      payload: data.job_payload,
      payloadHash: data.payload_hash,
      claimId: data.claim_id,
      leaseExpiresAt: data.lease_expires_at,
      attemptCount: data.attempt_count,
    };
  } catch (error) {
    if (error instanceof ResearchJobServiceError) throw error;
    throw serviceError("A research job could not be claimed.", error);
  }
}

export async function persistResearchResult({
  ownerId,
  jobId,
  claimId,
  schemaVersion,
  result,
  usage,
}) {
  let normalized;

  try {
    if (encodedJsonBytes(result) > PIPELINE.research.maxResultBytes) {
      throw serviceError("The research result exceeds the submission limit.");
    }
    if (
      usage !== undefined &&
      (!isJsonObject(usage) || encodedJsonBytes(usage) > 65_536)
    ) {
      throw serviceError("The research usage does not match the required shape.");
    }

    normalized = validateResearchResultShape(result);
    if (
      schemaVersion !== PIPELINE.research.schemaVersion ||
      normalized.schema_version !== schemaVersion
    ) {
      throw serviceError("The research result schema version is unsupported.");
    }
  } catch (error) {
    if (error instanceof ResearchJobServiceError) throw error;
    throw serviceError(
      "The research result does not match the required schema.",
      error,
    );
  }

  try {
    const db = createSupabaseAdminClient();
    const resultHash = hashResearchJson(normalized);
    const { data, error } = await db
      .rpc("submit_research_result", {
        p_owner_id: ownerId,
        p_job_id: jobId,
        p_claim_id: claimId,
        p_result: normalized,
        p_result_hash: resultHash,
      })
      .maybeSingle();

    if (
      error ||
      !validRpcRow(data, [
        "research_job_id",
        "run_id",
        "research_status",
        "newly_submitted",
      ])
    ) {
      throw serviceError("The research result was not accepted.", error);
    }

    await mergeRunUsagePatch(db, {
      ownerId,
      runId: data.run_id,
      usage,
    });

    return {
      status: data.newly_submitted ? "accepted" : "already_accepted",
      jobId: data.research_job_id,
      runId: data.run_id,
      researchStatus: data.research_status,
      newlySubmitted: data.newly_submitted,
      resultHash,
    };
  } catch (error) {
    if (error instanceof ResearchJobServiceError) throw error;
    throw serviceError("The research result was not accepted.", error);
  }
}

export async function submitResearchResultAndDispatch(args) {
  const persisted = await persistResearchResult(args);

  // The result is durable before dispatch. An identical replay can redrive a
  // still-submitted result, but it must not duplicate an active validating
  // workflow or a completed publication.
  if (
    persisted.newlySubmitted ||
    persisted.researchStatus === "submitted"
  ) {
    await dispatchResearchFinalizer(
      { jobId: persisted.jobId, ownerId: args.ownerId },
      "The result was saved, but finalization did not start. Retry this same submission.",
    );
    return { ...persisted, finalizerDispatched: true };
  }

  return { ...persisted, finalizerDispatched: false };
}

export async function reportResearchFailure({
  ownerId,
  jobId,
  claimId,
  errorCode,
}) {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .rpc("report_research_job_failure", {
        p_owner_id: ownerId,
        p_job_id: jobId,
        p_claim_id: claimId,
        p_error_code: errorCode,
        p_retry_delay_seconds: PIPELINE.research.retryDelaySeconds,
      })
      .maybeSingle();

    if (
      error ||
      !validRpcRow(data, ["research_job_id", "research_status"])
    ) {
      throw serviceError("The research failure could not be recorded.", error);
    }

    return {
      status:
        data.research_status === "failed" ? "failed" : "retry_scheduled",
      jobId: data.research_job_id,
      researchStatus: data.research_status,
      retryAt: data.retry_at ?? null,
    };
  } catch (error) {
    if (error instanceof ResearchJobServiceError) throw error;
    throw serviceError("The research failure could not be recorded.", error);
  }
}
