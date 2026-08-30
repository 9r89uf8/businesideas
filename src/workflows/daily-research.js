import {
  buildClusters,
  extractSignals,
  fetchAndRank,
  prepareResearchJob,
  recordWorkflowFailure,
} from "./daily-research-steps.js";

export async function dailyResearch({ runId, ownerId }) {
  "use workflow";

  let rankedPostIds;
  try {
    rankedPostIds = await fetchAndRank({ runId, ownerId });
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
