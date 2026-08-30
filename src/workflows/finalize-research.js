import {
  finalizeResearchResult,
  recordResearchFinalizerFailure,
} from "./research-finalizer-steps.js";

export async function finalizeResearch({ jobId, ownerId }) {
  "use workflow";

  try {
    const ideaIds = await finalizeResearchResult({ jobId, ownerId });
    return {
      status: ideaIds.length ? "completed" : "no_ideas",
      ideaIds,
    };
  } catch {
    const message = "The submitted research could not be validated.";
    await recordResearchFinalizerFailure({ jobId, ownerId, message });
    throw new Error("External research validation failed after retries.");
  }
}
