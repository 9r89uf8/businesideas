import { createWebhook, sleep } from "workflow";
import { PIPELINE } from "../lib/config.js";
import { connectionObservationFromCloudResult } from "../lib/x/for-you-connection.js";
import { launchCloudComparison, stopCloudComparison } from "./cloud-ideation-steps.js";
import {
  fetchAndRank,
  readIdeationProvider,
  recordWorkflowFailure,
  recordXForYouConnectionStatus,
} from "./daily-research-steps.js";
import {
  filterCommercialPosts,
  generateCandidateForPost,
  hydrateNeededPostContext,
  prepareCandidateResearchJob,
  shortlistCommercialPosts,
} from "./ideation-steps.js";
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
  completed = false,
} = {}) {
  return {
    candidates,
    completed,
    connection: checked ? { authState, errorCode } : null,
  };
}

function optionalForYouCallbackResult(result) {
  const observation = connectionObservationFromCloudResult(result);
  return optionalForYouResult({
    candidates: result?.status === "completed" ? result.candidates : [],
    completed: result?.status === "completed",
    ...observation,
  });
}

async function waitForForYouCommand(commandId, watchdog) {
  for (let poll = 0; poll < FOR_YOU_COMMAND_POLLS; poll += 1) {
    if (watchdog.stopped) return { status: "stopped" };
    await sleep("10s");
    if (watchdog.stopped) return { status: "stopped" };
    let command;
    try {
      command = await inspectXForYouCloudCommand({ commandId });
    } catch {
      // The webhook is the success signal. A temporary SSM control-plane
      // failure must not cut off a healthy browser run, so keep the bounded
      // wait alive and let the webhook side of the race win when available.
      continue;
    }
    if (watchdog.stopped) return { status: "stopped" };
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
  if (watchdog.stopped) return { status: "stopped" };
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
  const watchdog = { stopped: false };
  let commandWait;
  const webhookResult = webhook.then((request) => {
    watchdog.stopped = true;
    return { status: "received", request };
  });

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

    commandWait = waitForForYouCommand(sent.commandId, watchdog);
    const event = await Promise.race([
      webhookResult,
      commandWait,
    ]);
    if (event.status !== "received") return optionalForYouResult();
    const result = await parseXForYouCloudResult(event.request);
    return optionalForYouCallbackResult(result);
  } catch {
    return optionalForYouResult();
  } finally {
    // Promise.race does not cancel its loser. Stop scheduling watchdog work and
    // drain its current durable sleep/status step before this collection ends.
    watchdog.stopped = true;
    try {
      await commandWait;
    } catch {
      // Watchdog cleanup must not discard an already accepted callback.
    }
    try {
      await stopXForYouCloudInstance({
        region: activation.region,
        instanceId: activation.instanceId,
      });
    } catch {
      // The optional lane must not block the official-API research path; the
      // EC2 boot lease remains the final shutdown backstop.
    } finally {
      try {
        webhook.dispose();
      } catch {
        // A terminal workflow also disposes hooks; preserve the collection result.
      }
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
      forYouCollectionCompleted: forYouResult.completed,
    });
  } catch {
    const message = "Fetching and ranking failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (!rankedPostIds.length) return { status: "no_ideas" };

  let filtered;
  try {
    filtered = await filterCommercialPosts({
      runId,
      ownerId,
      selectedPostIds: rankedPostIds,
    });
  } catch {
    const message = "Commercial post filtering failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (!filtered.survivorPostIds.length) return { status: "no_ideas" };

  let survivorPostIds;
  try {
    survivorPostIds = await hydrateNeededPostContext({
      runId,
      ownerId,
      survivorPostIds: filtered.survivorPostIds,
      needsContextPostIds: filtered.needsContextPostIds,
    });
  } catch {
    const message = "Linked post context could not be hydrated after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (!survivorPostIds.length) return { status: "no_ideas" };

  let ideationProvider;
  try {
    ideationProvider = await readIdeationProvider({ runId, ownerId });
  } catch {
    const message = "The ideation provider could not be loaded.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (ideationProvider === "chatgpt_cloud") {
    try {
      const cloud = await launchCloudComparison({ runId, ownerId, survivorPostIds, mode: "primary" });
      if (cloud.status === "failed") {
        await recordWorkflowFailure({ runId, ownerId, message: "This cloud research attempt has already failed." });
      }
      return { status: cloud.status, provider: "chatgpt_cloud", cloudRunId: runId };
    } catch {
      try {
        await stopCloudComparison({ runId, ownerId, message: "Cloud research dispatch failed." });
      } finally {
        await recordWorkflowFailure({ runId, ownerId, message: "Cloud research dispatch failed." });
      }
      throw new Error("Cloud research dispatch failed. Sol API fallback is disabled.");
    }
  }

  // Explicit API rollback: compare an independent cloud chain against the API
  // pipeline. Its queue, decisions and validation never replace API checkpoints.
  try {
    await launchCloudComparison({ runId, ownerId, survivorPostIds });
  } catch {
    // Cloud dispatch failure must not interrupt the authoritative API run.
    try {
      await stopCloudComparison({ runId, ownerId, message: "Cloud comparison dispatch failed." });
    } catch {
      // A database outage must not turn comparison bookkeeping into an API gate.
    }
  }

  let shortlist;
  try {
    shortlist = await shortlistCommercialPosts({
      runId,
      ownerId,
      survivorPostIds,
    });
  } catch {
    const message = "Commercial shortlisting failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
  if (!shortlist.length) return { status: "no_ideas" };

  // Each step makes a separate Responses request with only one post in its
  // context. Workflow records successful steps independently, so a retry does
  // not turn this into a shared model conversation.
  await Promise.allSettled(
    shortlist.map((item) =>
      generateCandidateForPost({
        runId,
        ownerId,
        clusterId: item.clusterId,
        postId: item.postId,
      }),
    ),
  );

  let jobId;
  try {
    jobId = await prepareCandidateResearchJob({
      runId,
      ownerId,
      clusterIds: shortlist.map((item) => item.clusterId),
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
