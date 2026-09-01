import "server-only";

import { PIPELINE } from "../lib/config.js";
import { createOpenAIClient } from "../lib/openai/client.js";
import {
  buildResearchResponseRequest,
  parseResearchResponse,
} from "../lib/openai/research-response.js";
import { hashResearchJson } from "../lib/research/canonical-json.js";
import {
  claimResearchJobForOwner,
  getResearchJobState,
  persistResearchResult,
  reportResearchFailure,
} from "../lib/research/job-service.js";
import { validateResearchResultShape } from "../lib/validation.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESPONSE_ID_PATTERN = /^resp_[A-Za-z0-9_-]{1,190}$/;
const ACTIVE_RESPONSE_STATUSES = new Set(["queued", "in_progress"]);

function requireJobArgs({ jobId, ownerId } = {}) {
  if (!UUID_PATTERN.test(jobId || "") || !UUID_PATTERN.test(ownerId || "")) {
    throw new TypeError("API research requires valid job and owner IDs.");
  }
}

function requireResponseId(responseId) {
  if (!RESPONSE_ID_PATTERN.test(responseId || "")) {
    throw new TypeError("API research requires a valid response ID.");
  }
}

function safeTerminalResponse(response, { accessedAt } = {}) {
  const responseId =
    typeof response?.id === "string" && RESPONSE_ID_PATTERN.test(response.id)
      ? response.id
      : null;

  if (ACTIVE_RESPONSE_STATUSES.has(response?.status)) {
    if (!responseId) {
      return { status: "failed", errorCode: "research_unavailable" };
    }
    return { status: response.status, responseId, accessedAt };
  }

  if (response?.status !== "completed") {
    return {
      status: "failed",
      responseId,
      errorCode: "research_unavailable",
    };
  }

  try {
    const parsed = parseResearchResponse(response, { accessedAt });
    const result = validateResearchResultShape(parsed.data);
    return {
      status: "completed",
      responseId: parsed.responseId,
      result,
      usage: {
        research: {
          model: parsed.model,
          response_id: parsed.responseId,
          ...parsed.usage,
        },
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return {
      status: "failed",
      responseId,
      errorCode: /source|web search|opened|cited/i.test(message)
        ? "source_access_failed"
        : "submission_invalid",
    };
  }
}

export async function loadPreparedResearchJob({ jobId, ownerId }) {
  "use step";

  requireJobArgs({ jobId, ownerId });
  const state = await getResearchJobState({ ownerId, jobId });
  if (!state) throw new Error("The prepared research job was not found.");
  return state;
}
loadPreparedResearchJob.maxRetries = 3;

export async function claimPreparedResearchJob({ jobId, ownerId }) {
  "use step";

  requireJobArgs({ jobId, ownerId });
  const claim = await claimResearchJobForOwner(ownerId);
  if (!claim) return null;
  if (claim.jobId !== jobId || claim.runId !== claim.payload?.run_id) {
    throw new Error("A different research job was claimed.");
  }
  if (
    claim.schemaVersion !== PIPELINE.research.schemaVersion ||
    claim.promptVersion !== PIPELINE.research.promptVersion ||
    claim.payload?.schema_version !== claim.schemaVersion ||
    claim.payload?.prompt_version !== claim.promptVersion ||
    hashResearchJson(claim.payload) !== claim.payloadHash
  ) {
    throw new Error("The claimed research payload failed integrity checks.");
  }
  return claim;
}
claimPreparedResearchJob.maxRetries = 0;

export async function startOpenAIResearchResponse({ claim }) {
  "use step";

  if (
    !claim ||
    !UUID_PATTERN.test(claim.jobId || "") ||
    !Number.isInteger(claim.attemptCount) ||
    claim.attemptCount < 1 ||
    claim.attemptCount > PIPELINE.research.maxAttempts
  ) {
    throw new TypeError("A valid research claim is required.");
  }

  const accessedAt = new Date().toISOString();
  const request = buildResearchResponseRequest({
    jobId: claim.jobId,
    promptVersion: claim.promptVersion,
    payload: claim.payload,
    accessedAt,
  });
  const response = await createOpenAIClient().responses.create(request, {
    timeout: 30_000,
    maxRetries: 0,
    headers: {
      "X-Client-Request-Id": `sf-research-${claim.jobId}-${claim.attemptCount}`,
    },
  });
  return safeTerminalResponse(response, { accessedAt });
}
// Responses creation has no documented idempotency guarantee. Keep both SDK
// and Workflow retries disabled so one database claim makes one POST attempt.
startOpenAIResearchResponse.maxRetries = 0;

export async function pollOpenAIResearchResponse({ responseId, accessedAt }) {
  "use step";

  requireResponseId(responseId);
  const response = await createOpenAIClient().responses.retrieve(
    responseId,
    { include: ["web_search_call.action.sources"] },
    { timeout: 30_000, maxRetries: 2 },
  );
  return safeTerminalResponse(response, { accessedAt });
}
pollOpenAIResearchResponse.maxRetries = 3;

export async function cancelOpenAIResearchResponse({ responseId, accessedAt }) {
  "use step";

  requireResponseId(responseId);
  try {
    const response = await createOpenAIClient().responses.cancel(responseId, {
      timeout: 30_000,
      maxRetries: 0,
    });
    return safeTerminalResponse(response, { accessedAt });
  } catch {
    try {
      const response = await createOpenAIClient().responses.retrieve(
        responseId,
        { include: ["web_search_call.action.sources"] },
        { timeout: 30_000, maxRetries: 1 },
      );
      return safeTerminalResponse(response, { accessedAt });
    } catch {
      return {
        status: "failed",
        responseId,
        errorCode: "research_unavailable",
      };
    }
  }
}
cancelOpenAIResearchResponse.maxRetries = 0;

export async function deleteOpenAIResearchResponse({ responseId }) {
  "use step";

  requireResponseId(responseId);
  try {
    await createOpenAIClient().responses.delete(responseId, {
      timeout: 30_000,
      maxRetries: 1,
    });
    return { deleted: true };
  } catch {
    // Cleanup must not undo an already durable database result.
    return { deleted: false };
  }
}
deleteOpenAIResearchResponse.maxRetries = 0;

export async function persistOpenAIResearchResult({
  ownerId,
  claim,
  result,
  usage,
}) {
  "use step";

  requireJobArgs({ jobId: claim?.jobId, ownerId });
  return persistResearchResult({
    ownerId,
    jobId: claim.jobId,
    claimId: claim.claimId,
    schemaVersion: claim.schemaVersion,
    result,
    usage,
  });
}
persistOpenAIResearchResult.maxRetries = 3;

export async function reportOpenAIResearchFailure({
  ownerId,
  claim,
  errorCode,
}) {
  "use step";

  requireJobArgs({ jobId: claim?.jobId, ownerId });
  return reportResearchFailure({
    ownerId,
    jobId: claim.jobId,
    claimId: claim.claimId,
    errorCode,
  });
}
reportOpenAIResearchFailure.maxRetries = 3;
