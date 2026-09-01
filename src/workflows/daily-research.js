import { createWebhook, sleep } from "workflow";
import { PIPELINE } from "../lib/config.js";
import { connectionObservationFromCloudResult } from "../lib/x/for-you-connection.js";
import {
  buildClusters,
  extractSignals,
  fetchAndRank,
  prepareResearchJob,
  recordWorkflowFailure,
  recordXForYouConnectionStatus,
} from "./daily-research-steps.js";
import {
  cancelOpenAIResearchResponse,
  claimPreparedResearchJob,
  deleteOpenAIResearchResponse,
  loadPreparedResearchJob,
  persistOpenAIResearchResult,
  pollOpenAIResearchResponse,
  reportOpenAIResearchFailure,
  startOpenAIResearchResponse,
} from "./openai-research-steps.js";
import {
  finalizeResearchResult,
  recordResearchFinalizerFailure,
} from "./research-finalizer-steps.js";
import {
  inspectXForYouCloudCommand,
  inspectXForYouCloudReadiness,
  parseXForYouCloudResult,
  readXForYouCloudActivation,
  sendXForYouCloudCollection,
  startXForYouCloudInstance,
  stopXForYouCloudInstance,
} from "./x-for-you-cloud-steps.js";

const READY_TO_FINALIZE = new Set(["submitted", "validating", "completed"]);
const FOR_YOU_READINESS_POLLS = 36;
const FOR_YOU_COMMAND_POLLS = 119;

function optionalForYouResult({
  candidates = [],
  authState = "unknown",
  errorCode = null,
  checked = true,
} = {}) {
  return {
    candidates,
    connection: checked ? { authState, errorCode } : null,
  };
}

function optionalForYouCallbackResult(result) {
  const observation = connectionObservationFromCloudResult(result);
  return optionalForYouResult({
    candidates: result?.status === "completed" ? result.candidates : [],
    ...observation,
  });
}

async function waitForForYouCommand(commandId) {
  for (let poll = 0; poll < FOR_YOU_COMMAND_POLLS; poll += 1) {
    await sleep("10s");
    let command;
    try {
      command = await inspectXForYouCloudCommand({ commandId });
    } catch {
      // The webhook is the success signal. A temporary SSM control-plane
      // failure must not cut off a healthy browser run, so keep the bounded
      // wait alive and let the webhook side of the race win when available.
      continue;
    }
    if (["failed", "succeeded"].includes(command.status)) {
      // A callback may have been accepted even when the worker lost the HTTP
      // response and SSM reports failure. Keep the race alive briefly for any
      // terminal command state so durable event ordering cannot discard it.
      await sleep("30s");
      return command.status === "succeeded"
        ? { status: "missing_result" }
        : command;
    }
  }
  // The final status poll and an accepted webhook can cross in flight too.
  await sleep("30s");
  return { status: "timeout" };
}

async function collectOptionalForYouCandidates() {
  let activation;
  try {
    activation = await readXForYouCloudActivation();
  } catch {
    return optionalForYouResult();
  }
  if (activation.status !== "enabled") {
    return optionalForYouResult({ checked: false });
  }

  let webhook;
  try {
    webhook = createWebhook();
  } catch {
    return optionalForYouResult();
  }
  const webhookResult = webhook.then((request) => ({
    status: "received",
    request,
  }));

  try {
    const started = await startXForYouCloudInstance();
    if (!["starting", "running"].includes(started.status)) {
      return optionalForYouResult();
    }

    let ready = false;
    for (let poll = 0; poll < FOR_YOU_READINESS_POLLS; poll += 1) {
      const state = await inspectXForYouCloudReadiness();
      if (state.status === "ready") {
        ready = true;
        break;
      }
      if (state.status !== "pending") return optionalForYouResult();
      await sleep("5s");
    }
    if (!ready) return optionalForYouResult();

    const sent = await sendXForYouCloudCollection({
      resultUrl: webhook.url,
    });
    if (sent.status !== "sent") return optionalForYouResult();

    const event = await Promise.race([
      webhookResult,
      waitForForYouCommand(sent.commandId),
    ]);
    if (event.status !== "received") return optionalForYouResult();
    const result = await parseXForYouCloudResult(event.request);
    return optionalForYouCallbackResult(result);
  } catch {
    return optionalForYouResult();
  } finally {
    try {
      await stopXForYouCloudInstance({
        region: activation.region,
        instanceId: activation.instanceId,
      });
    } catch {
      // The optional lane must not block the official-API research path; the
      // EC2 boot lease remains the final shutdown backstop.
    } finally {
      webhook.dispose();
    }
  }
}

async function finishSubmittedResearch({ jobId, ownerId }) {
  try {
    const ideaIds = await finalizeResearchResult({ jobId, ownerId });
    return {
      status: ideaIds.length ? "completed" : "no_ideas",
      jobId,
      ideaIds,
    };
  } catch {
    const message = "The API research result could not be validated.";
    await recordResearchFinalizerFailure({ jobId, ownerId, message });
    throw new Error("API research validation failed after retries.");
  }
}

export async function dailyResearch({ runId, ownerId }) {
  "use workflow";

  const forYouResult = await collectOptionalForYouCandidates();
  if (forYouResult.connection) {
    try {
      await recordXForYouConnectionStatus({
        runId,
        ownerId,
        ...forYouResult.connection,
      });
    } catch {
      // Connection visibility is optional and must not block research.
    }
  }
  const forYouCandidates = forYouResult.candidates.map(
    (candidate) => ({
      post_id: candidate.postId,
      feed_position: candidate.feedPosition,
    }),
  );

  let rankedPostIds;
  try {
    rankedPostIds = await fetchAndRank({
      runId,
      ownerId,
      forYouCandidates,
    });
  } catch {
    const message = "Fetching and ranking failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (rankedPostIds.length < 5) return { status: "no_ideas" };

  let signalPostIds;
  try {
    signalPostIds = await extractSignals({
      runId,
      ownerId,
      selectedPostIds: rankedPostIds,
    });
  } catch {
    const message = "Signal extraction failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (signalPostIds.length < 5) return { status: "no_ideas" };

  let clusterIds;
  try {
    clusterIds = await buildClusters({ runId, ownerId, signalPostIds });
  } catch {
    const message = "Opportunity clustering failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (!clusterIds.length) return { status: "no_ideas" };

  let jobId;
  try {
    jobId = await prepareResearchJob({
      runId,
      ownerId,
      clusterIds,
    });
  } catch {
    const message = "Research job preparation failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (!jobId) return { status: "no_ideas" };

  let claim = null;
  let generated = null;
  const maximumCycles = PIPELINE.research.maxAttempts * 4;

  for (let cycle = 0; cycle < maximumCycles; cycle += 1) {
    if (!claim) {
      const state = await loadPreparedResearchJob({ jobId, ownerId });

      if (READY_TO_FINALIZE.has(state.status)) {
        return finishSubmittedResearch({ jobId, ownerId });
      }
      if (state.status === "failed") {
        return { status: "failed", jobId };
      }
      if (state.status === "claimed") {
        if (!state.leaseExpiresAt) {
          throw new Error("The active API research claim has no lease.");
        }
        await sleep(new Date(state.leaseExpiresAt));
      } else if (state.status === "pending" && state.availableAt) {
        await sleep(new Date(state.availableAt));
      } else {
        throw new Error("The API research job is not claimable.");
      }

      try {
        claim = await claimPreparedResearchJob({ jobId, ownerId });
      } catch {
        // A claim RPC can commit even if its response is lost. Reloading the
        // durable row distinguishes an active lease from a transient failure.
        claim = null;
        await sleep("5s");
        continue;
      }
      if (!claim) continue;
    }

    if (!generated) {
      let response = null;
      try {
        response = await startOpenAIResearchResponse({ claim });
        let elapsedSeconds = 0;
        let pollSeconds = PIPELINE.research.pollInitialSeconds;

        while (
          ["queued", "in_progress"].includes(response.status) &&
          elapsedSeconds < PIPELINE.research.responseDeadlineSeconds
        ) {
          await sleep(`${pollSeconds}s`);
          elapsedSeconds += pollSeconds;
          response = await pollOpenAIResearchResponse({
            responseId: response.responseId,
            accessedAt: response.accessedAt,
          });
          pollSeconds = Math.min(
            PIPELINE.research.pollMaximumSeconds,
            Math.ceil(pollSeconds * 1.5),
          );
        }

        if (["queued", "in_progress"].includes(response.status)) {
          response = await cancelOpenAIResearchResponse({
            responseId: response.responseId,
            accessedAt: response.accessedAt,
          });
        }

        if (response.status === "completed") {
          generated = {
            result: response.result,
            usage: response.usage,
            responseId: response.responseId,
          };
        } else {
          if (response.responseId) {
            await deleteOpenAIResearchResponse({
              responseId: response.responseId,
            });
          }
          const failure = await reportOpenAIResearchFailure({
            ownerId,
            claim,
            errorCode: response.errorCode || "research_unavailable",
          });
          claim = null;
          if (failure.status === "failed") {
            return { status: "failed", jobId };
          }
          if (failure.retryAt) await sleep(new Date(failure.retryAt));
          continue;
        }
      } catch {
        let recovered = null;
        if (response?.responseId) {
          recovered = await cancelOpenAIResearchResponse({
            responseId: response.responseId,
            accessedAt: response.accessedAt,
          });
        }

        if (recovered?.status === "completed") {
          generated = {
            result: recovered.result,
            usage: recovered.usage,
            responseId: recovered.responseId,
          };
        } else {
          if (response?.responseId) {
            await deleteOpenAIResearchResponse({
              responseId: response.responseId,
            });
          }
          try {
            const failure = await reportOpenAIResearchFailure({
              ownerId,
              claim,
              errorCode: "research_unavailable",
            });
            claim = null;
            if (failure.status === "failed") {
              return { status: "failed", jobId };
            }
            if (failure.retryAt) await sleep(new Date(failure.retryAt));
          } catch {
            // The next state read resolves an ambiguous failure-report commit.
            claim = null;
          }
          continue;
        }
      }
    }

    try {
      await persistOpenAIResearchResult({
        ownerId,
        claim,
        result: generated.result,
        usage: generated.usage,
      });
      if (generated.responseId) {
        await deleteOpenAIResearchResponse({
          responseId: generated.responseId,
        });
      }
      return finishSubmittedResearch({ jobId, ownerId });
    } catch {
      if (generated.responseId) {
        await deleteOpenAIResearchResponse({
          responseId: generated.responseId,
        });
        generated = { ...generated, responseId: null };
      }
      const state = await loadPreparedResearchJob({ jobId, ownerId });
      if (READY_TO_FINALIZE.has(state.status)) {
        return finishSubmittedResearch({ jobId, ownerId });
      }
      if (state.status === "failed") {
        return { status: "failed", jobId };
      }

      try {
        const failure = await reportOpenAIResearchFailure({
          ownerId,
          claim,
          errorCode: "submission_invalid",
        });
        claim = null;
        if (failure.status === "failed") {
          return { status: "failed", jobId };
        }
        if (failure.retryAt) await sleep(new Date(failure.retryAt));
      } catch {
        // Preserve the generated result. After an ambiguous report, the next
        // state read either waits for this lease or reclaims the pending job.
        claim = null;
      }
    }
  }

  const finalState = await loadPreparedResearchJob({ jobId, ownerId });
  if (READY_TO_FINALIZE.has(finalState.status)) {
    return finishSubmittedResearch({ jobId, ownerId });
  }
  if (finalState.status === "failed") {
    return { status: "failed", jobId };
  }

  const message = "API research did not reach a terminal state.";
  await recordResearchFinalizerFailure({ jobId, ownerId, message });
  throw new Error(message);
}
