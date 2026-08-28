export const RUN_STAGE_LABELS = {
  fetching: "Fetching and ranking X posts",
  extracting: "Extracting commercial signals",
  clustering: "Building opportunity clusters",
  generating: "Generating business hypotheses",
  saving: "Validating and saving ideas",
};

const SAFE_FAILURE_FALLBACK =
  "The research workflow stopped unexpectedly. No provider details were exposed.";

export function getRunStageLabel(stage) {
  if (!stage) return "Not recorded";
  return RUN_STAGE_LABELS[stage] || "Unknown stage";
}

export function describeRun(run) {
  if (!run) {
    return {
      label: "Ready",
      detail: "No research run has started yet.",
      lastStage: null,
      safeError: null,
    };
  }

  if (run.status === "queued") {
    return {
      label: "Queued",
      detail: "The durable workflow is preparing to start.",
      lastStage: null,
      safeError: null,
    };
  }

  if (run.status === "running") {
    return {
      label: "Researching",
      detail: run.stage
        ? getRunStageLabel(run.stage)
        : "The daily research workflow is active.",
      lastStage: null,
      safeError: null,
    };
  }

  if (run.status === "completed") {
    return {
      label: "Complete",
      detail: "Today’s strongest non-duplicate ideas are ready.",
      lastStage: null,
      safeError: null,
    };
  }

  if (run.status === "no_ideas") {
    return {
      label: "No ideas",
      detail: "The evidence did not clear today’s quality gates.",
      lastStage: null,
      safeError: null,
    };
  }

  return {
    label: "Needs attention",
    detail: "The research workflow stopped before it could finish.",
    lastStage: getRunStageLabel(run.stage),
    safeError:
      typeof run.error_message === "string" && run.error_message.trim()
        ? run.error_message.trim()
        : SAFE_FAILURE_FALLBACK,
  };
}
