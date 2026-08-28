import {
  buildClusters,
  extractSignals,
  fetchAndRank,
  generateDeduplicateAndSave,
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
    const ideaIds = await generateDeduplicateAndSave({
      runId,
      ownerId,
      clusterIds,
    });
    return { status: ideaIds.length ? "completed" : "no_ideas", ideaIds };
  } catch {
    const message = "Idea generation failed after retries.";
    await recordWorkflowFailure({ runId, ownerId, message });
    throw new Error(message);
  }
}
