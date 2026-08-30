import "server-only";

import { start } from "workflow/api";
import { z } from "zod";
import { PIPELINE } from "@/lib/config";
import { hashResearchJson } from "@/lib/research/canonical-json";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateResearchResultShape } from "@/lib/validation";
import { finalizeResearch } from "@/workflows/finalize-research";

const FAILURE_CODES = Object.freeze([
  "research_unavailable",
  "source_access_failed",
  "submission_invalid",
  "tool_error",
]);

const UUID = z.string().uuid();
const JSON_OBJECT = z.record(z.string(), z.json());

const claimOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }).strict(),
  z
    .object({
      status: z.literal("claimed"),
      job_id: UUID,
      run_id: UUID,
      schema_version: z.number().int().positive(),
      prompt_version: z.string().min(1),
      payload: JSON_OBJECT,
      payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
      claim_id: UUID,
      lease_expires_at: z.string().datetime({ offset: true }),
      attempt_count: z.number().int().positive(),
    })
    .strict(),
]);

const submitOutputSchema = z
  .object({
    status: z.enum(["accepted", "already_accepted"]),
    job_id: UUID,
    run_id: UUID,
    research_status: z.enum(["submitted", "validating", "completed"]),
  })
  .strict();

const failureOutputSchema = z
  .object({
    status: z.enum(["retry_scheduled", "failed"]),
    job_id: UUID,
    research_status: z.enum(["pending", "failed"]),
    retry_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

function authorizedOwnerId(context) {
  const ownerId = process.env.OWNER_USER_ID?.trim();
  const authenticatedOwner = context?.http?.authInfo?.extra?.ownerId;

  if (!ownerId || authenticatedOwner !== ownerId) {
    throw new Error("Unauthorized worker context.");
  }

  return ownerId;
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function toolSuccess(output, message) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: output,
  };
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

async function claimResearchJob(_input, context) {
  try {
    const ownerId = authorizedOwnerId(context);
    const db = createSupabaseAdminClient();

    // Submission is durable before finalizer dispatch. If that dispatch was
    // interrupted after commit, or a validating workflow has been stalled for
    // at least the configured threshold, the next hourly queue check redrives
    // the idempotent finalizer before claiming new research. The stale guard
    // avoids racing a healthy finalizer. Returning `empty` keeps the worker to
    // one unit of work.
    const staleValidationBefore = new Date(
      Date.now() - PIPELINE.research.validationRedriveSeconds * 1_000,
    ).toISOString();
    const { data: stranded, error: strandedError } = await db
      .from("research_jobs")
      .select("id")
      .eq("owner_id", ownerId)
      .or(
        `status.eq.submitted,and(status.eq.validating,validation_started_at.lt.${staleValidationBefore})`,
      )
      .order("submitted_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (strandedError) {
      return toolError("Pending research finalization could not be checked.");
    }
    if (stranded?.id) {
      try {
        await start(finalizeResearch, [{ jobId: stranded.id, ownerId }]);
      } catch {
        return toolError("Pending research finalization could not be restarted.");
      }

      return toolSuccess(
        { status: "empty" },
        "Pending research finalization was restarted; no job was claimed.",
      );
    }

    const { data, error } = await db
      .rpc("claim_pending_research_job", {
        p_owner_id: ownerId,
        p_lease_seconds: PIPELINE.research.leaseSeconds,
      })
      .maybeSingle();

    if (error) return toolError("A research job could not be claimed.");
    if (!data) {
      return toolSuccess({ status: "empty" }, "No research job is pending.");
    }

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
      return toolError("The claimed research job was incomplete.");
    }

    const output = {
      status: "claimed",
      job_id: data.research_job_id,
      run_id: data.run_id,
      schema_version: data.schema_version,
      prompt_version: data.prompt_version,
      payload: data.job_payload,
      payload_hash: data.payload_hash,
      claim_id: data.claim_id,
      lease_expires_at: data.lease_expires_at,
      attempt_count: data.attempt_count,
    };

    const parsed = claimOutputSchema.safeParse(output);
    if (!parsed.success) {
      return toolError("The claimed research job was invalid.");
    }

    return toolSuccess(parsed.data, "A research job was claimed.");
  } catch {
    return toolError("A research job could not be claimed.");
  }
}

async function submitResearchResult(
  { job_id: jobId, claim_id: claimId, schema_version: schemaVersion, result },
  context,
) {
  let normalized;

  try {
    if (encodedJsonBytes(result) > PIPELINE.research.maxResultBytes) {
      return toolError("The research result exceeds the submission limit.");
    }

    normalized = validateResearchResultShape(result);
    if (
      schemaVersion !== PIPELINE.research.schemaVersion ||
      normalized.schema_version !== schemaVersion
    ) {
      return toolError("The research result schema version is unsupported.");
    }
  } catch {
    return toolError("The research result does not match the required schema.");
  }

  try {
    const ownerId = authorizedOwnerId(context);
    const resultHash = hashResearchJson(normalized);
    const { data, error } = await createSupabaseAdminClient()
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
      return toolError("The research result was not accepted.");
    }

    // The result is durable before dispatch. An identical replay can redrive a
    // still-submitted result, but it must not duplicate an active validating
    // workflow or a completed publication.
    if (data.newly_submitted || data.research_status === "submitted") {
      try {
        await start(finalizeResearch, [
          { jobId: data.research_job_id, ownerId },
        ]);
      } catch {
        return toolError(
          "The result was saved, but finalization did not start. Retry this same submission.",
        );
      }
    }

    const output = {
      status: data.newly_submitted ? "accepted" : "already_accepted",
      job_id: data.research_job_id,
      run_id: data.run_id,
      research_status: data.research_status,
    };
    const parsed = submitOutputSchema.safeParse(output);
    if (!parsed.success) {
      return toolError("The result was saved, but its status was unavailable.");
    }

    return toolSuccess(parsed.data, "The research result was accepted.");
  } catch {
    return toolError("The research result was not accepted.");
  }
}

async function reportResearchFailure(
  { job_id: jobId, claim_id: claimId, error_code: errorCode },
  context,
) {
  try {
    const ownerId = authorizedOwnerId(context);
    const { data, error } = await createSupabaseAdminClient()
      .rpc("report_research_job_failure", {
        p_owner_id: ownerId,
        p_job_id: jobId,
        p_claim_id: claimId,
        p_error_code: errorCode,
        p_retry_delay_seconds: 900,
      })
      .maybeSingle();

    if (
      error ||
      !validRpcRow(data, ["research_job_id", "research_status"])
    ) {
      return toolError("The research failure could not be recorded.");
    }

    const output = {
      status:
        data.research_status === "failed" ? "failed" : "retry_scheduled",
      job_id: data.research_job_id,
      research_status: data.research_status,
      retry_at: data.retry_at ?? null,
    };
    const parsed = failureOutputSchema.safeParse(output);
    if (!parsed.success) {
      return toolError("The research failure status was unavailable.");
    }

    return toolSuccess(parsed.data, "The research failure was recorded.");
  } catch {
    return toolError("The research failure could not be recorded.");
  }
}

export function registerResearchTools(server) {
  server.registerTool(
    "claim_research_job",
    {
      title: "Claim research job",
      description:
        "Recover pending finalization or atomically claim the oldest research job for the private owner. Returns empty when no research work is claimed.",
      inputSchema: z.object({}).strict(),
      outputSchema: claimOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    claimResearchJob,
  );

  server.registerTool(
    "submit_research_result",
    {
      title: "Submit research result",
      description:
        "Validate and submit one completed evidence-backed research result for an active claim. Replaying the identical accepted result is safe.",
      inputSchema: z
        .object({
          job_id: UUID.describe("Claimed research job UUID."),
          claim_id: UUID.describe("Active claim capability UUID."),
          schema_version: z
            .number()
            .int()
            .positive()
            .describe("Schema version returned by claim_research_job."),
          result: JSON_OBJECT.describe(
            "Complete result object matching the job's scheduled-research schema.",
          ),
        })
        .strict(),
      outputSchema: submitOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    submitResearchResult,
  );

  server.registerTool(
    "report_research_failure",
    {
      title: "Report research failure",
      description:
        "Release an active claim after a bounded worker failure so the job can retry or stop after its final attempt.",
      inputSchema: z
        .object({
          job_id: UUID.describe("Claimed research job UUID."),
          claim_id: UUID.describe("Active claim capability UUID."),
          error_code: z
            .enum(FAILURE_CODES)
            .describe("Safe failure category; never include source text or secrets."),
        })
        .strict(),
      outputSchema: failureOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    reportResearchFailure,
  );
}
