import "server-only";

import { z } from "zod";
import {
  claimResearchJobForOwner,
  redriveStrandedResearchFinalization,
  RESEARCH_FAILURE_CODES,
  ResearchJobServiceError,
  reportResearchFailure as reportResearchFailureForOwner,
  submitResearchResultAndDispatch,
} from "@/lib/research/job-service";

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

function safeServiceErrorMessage(error, fallback) {
  return error instanceof ResearchJobServiceError ? error.message : fallback;
}

async function claimResearchJob(_input, context) {
  try {
    const ownerId = authorizedOwnerId(context);
    const recovery = await redriveStrandedResearchFinalization(ownerId);
    if (recovery) {
      return toolSuccess(
        { status: "empty" },
        "Pending research finalization was restarted; no job was claimed.",
      );
    }

    const claimed = await claimResearchJobForOwner(ownerId);
    if (!claimed) {
      return toolSuccess({ status: "empty" }, "No research job is pending.");
    }

    const output = {
      status: "claimed",
      job_id: claimed.jobId,
      run_id: claimed.runId,
      schema_version: claimed.schemaVersion,
      prompt_version: claimed.promptVersion,
      payload: claimed.payload,
      payload_hash: claimed.payloadHash,
      claim_id: claimed.claimId,
      lease_expires_at: claimed.leaseExpiresAt,
      attempt_count: claimed.attemptCount,
    };

    const parsed = claimOutputSchema.safeParse(output);
    if (!parsed.success) {
      return toolError("The claimed research job was invalid.");
    }

    return toolSuccess(parsed.data, "A research job was claimed.");
  } catch (error) {
    return toolError(
      safeServiceErrorMessage(error, "A research job could not be claimed."),
    );
  }
}

async function submitResearchResult(
  { job_id: jobId, claim_id: claimId, schema_version: schemaVersion, result },
  context,
) {
  try {
    const ownerId = authorizedOwnerId(context);
    const submitted = await submitResearchResultAndDispatch({
      ownerId,
      jobId,
      claimId,
      schemaVersion,
      result,
    });

    const output = {
      status: submitted.status,
      job_id: submitted.jobId,
      run_id: submitted.runId,
      research_status: submitted.researchStatus,
    };

    const parsed = submitOutputSchema.safeParse(output);
    if (!parsed.success) {
      return toolError("The result was saved, but its status was unavailable.");
    }

    return toolSuccess(parsed.data, "The research result was accepted.");
  } catch (error) {
    return toolError(
      safeServiceErrorMessage(error, "The research result was not accepted."),
    );
  }
}

async function reportResearchFailure(
  { job_id: jobId, claim_id: claimId, error_code: errorCode },
  context,
) {
  try {
    const ownerId = authorizedOwnerId(context);
    const result = await reportResearchFailureForOwner({
      ownerId,
      jobId,
      claimId,
      errorCode,
    });

    const output = {
      status: result.status,
      job_id: result.jobId,
      research_status: result.researchStatus,
      retry_at: result.retryAt,
    };

    const parsed = failureOutputSchema.safeParse(output);
    if (!parsed.success) {
      return toolError("The research failure status was unavailable.");
    }

    return toolSuccess(parsed.data, "The research failure was recorded.");
  } catch (error) {
    return toolError(
      safeServiceErrorMessage(
        error,
        "The research failure could not be recorded.",
      ),
    );
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
            .enum(RESEARCH_FAILURE_CODES)
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
