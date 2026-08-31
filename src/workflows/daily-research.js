import { createWebhook, sleep } from "workflow";
import {
  buildClusters,
  extractSignals,
  fetchAndRank,
  prepareResearchJob,
  recordWorkflowFailure,
} from "./daily-research-steps.js";
import {
  inspectXForYouCloudCommand,
  inspectXForYouCloudReadiness,
  parseXForYouCloudResult,
  readXForYouCloudActivation,
  sendXForYouCloudCollection,
  startXForYouCloudInstance,
  stopXForYouCloudInstance,
} from "./x-for-you-cloud-steps.js";

const FOR_YOU_READINESS_POLLS = 36;
const FOR_YOU_COMMAND_POLLS = 119;

async function waitForForYouCommand(commandId) {
  for (let poll = 0; poll < FOR_YOU_COMMAND_POLLS; poll += 1) {
    await sleep("10s");
    let command;
    try {
      command = await inspectXForYouCloudCommand({ commandId });
    } catch {
      continue;
    }
    if (["failed", "succeeded"].includes(command.status)) {
      // Give an accepted callback enough time to win the durable event race.
      await sleep("30s");
      return command.status === "succeeded"
        ? { status: "missing_result" }
        : command;
    }
  }
  await sleep("30s");
  return { status: "timeout" };
}

async function collectOptionalForYouCandidates() {
  let activation;
  try {
    activation = await readXForYouCloudActivation();
  } catch {
    return [];
  }
  if (activation.status !== "enabled") return [];

  let webhook;
  try {
    webhook = createWebhook();
  } catch {
    return [];
  }
  const webhookResult = webhook.then((request) => ({
    status: "received",
    request,
  }));

  try {
    const started = await startXForYouCloudInstance();
    if (!["starting", "running"].includes(started.status)) return [];

    let ready = false;
    for (let poll = 0; poll < FOR_YOU_READINESS_POLLS; poll += 1) {
      const state = await inspectXForYouCloudReadiness();
      if (state.status === "ready") {
        ready = true;
        break;
      }
      if (state.status !== "pending") return [];
      await sleep("5s");
    }
    if (!ready) return [];

    const sent = await sendXForYouCloudCollection({
      resultUrl: webhook.url,
    });
    if (sent.status !== "sent") return [];

    const event = await Promise.race([
      webhookResult,
      waitForForYouCommand(sent.commandId),
    ]);
    if (event.status !== "received") return [];
    const result = await parseXForYouCloudResult(event.request);
    return result.candidates;
  } catch {
    return [];
  } finally {
    try {
      await stopXForYouCloudInstance({
        region: activation.region,
        instanceId: activation.instanceId,
      });
    } catch {
      // The EC2 boot lease remains the final shutdown backstop.
    } finally {
      webhook.dispose();
    }
  }
}

export async function dailyResearch({ runId, ownerId }) {
  "use workflow";

  const forYouCandidates = (await collectOptionalForYouCandidates()).map(
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

  try {
    const jobId = await prepareResearchJob({
      runId,
      ownerId,
      clusterIds,
    });
    return jobId
      ? { status: "research_queued", jobId }
      : { status: "no_ideas" };
  } catch {
    const message = "Research job preparation failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
}
