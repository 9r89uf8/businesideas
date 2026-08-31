function integerOption(value, fallback, { label, minimum, maximum }) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${label} is outside its supported range.`);
  }
  return parsed;
}

function booleanOption(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${label} must be exactly true or false.`);
}

export function resolveCollectorRuntimeOptions(env = process.env) {
  return Object.freeze({
    maximumScrolls: integerOption(env.X_WEB_AUTOMATION_MAX_SCROLLS, 60, {
      label: "X web maximum scrolls",
      minimum: 0,
      maximum: 200,
    }),
    maximumNoGrowthCycles: integerOption(
      env.X_WEB_AUTOMATION_MAX_NO_GROWTH_CYCLES,
      5,
      {
        label: "X web no-growth cycles",
        minimum: 1,
        maximum: 20,
      },
    ),
    maximumRuntimeMs: integerOption(
      env.X_WEB_AUTOMATION_MAX_RUNTIME_MS,
      300_000,
      {
        label: "X web maximum runtime",
        minimum: 1_000,
        maximum: 900_000,
      },
    ),
    loadWaitMs: integerOption(env.X_WEB_AUTOMATION_LOAD_WAIT_MS, 2_500, {
      label: "X web feed wait",
      minimum: 250,
      maximum: 30_000,
    }),
    stateTimeoutMs: integerOption(
      env.X_WEB_AUTOMATION_STATE_TIMEOUT_MS,
      20_000,
      {
        label: "X web state timeout",
        minimum: 1_000,
        maximum: 120_000,
      },
    ),
    manualActionTimeoutMs: integerOption(
      env.X_WEB_AUTOMATION_MANUAL_ACTION_TIMEOUT_MS,
      300_000,
      {
        label: "X web manual-action timeout",
        minimum: 10_000,
        maximum: 900_000,
      },
    ),
    interactiveChallenges: booleanOption(
      env.X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES,
      false,
      "X web interactive-challenge mode",
    ),
    includeRawText: booleanOption(
      env.X_WEB_AUTOMATION_INCLUDE_RAW_TEXT,
      false,
      "X web raw-text output",
    ),
    saveFailureScreenshot: booleanOption(
      env.X_WEB_AUTOMATION_SAVE_FAILURE_SCREENSHOT,
      true,
      "X web failure screenshots",
    ),
  });
}

export function validateCollectorRuntimeOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("Resolved X web collector options are required.");
  }

  return resolveCollectorRuntimeOptions({
    X_WEB_AUTOMATION_MAX_SCROLLS: String(options.maximumScrolls),
    X_WEB_AUTOMATION_MAX_NO_GROWTH_CYCLES: String(
      options.maximumNoGrowthCycles,
    ),
    X_WEB_AUTOMATION_MAX_RUNTIME_MS: String(options.maximumRuntimeMs),
    X_WEB_AUTOMATION_LOAD_WAIT_MS: String(options.loadWaitMs),
    X_WEB_AUTOMATION_STATE_TIMEOUT_MS: String(options.stateTimeoutMs),
    X_WEB_AUTOMATION_MANUAL_ACTION_TIMEOUT_MS: String(
      options.manualActionTimeoutMs,
    ),
    X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES: String(
      options.interactiveChallenges,
    ),
    X_WEB_AUTOMATION_INCLUDE_RAW_TEXT: String(options.includeRawText),
    X_WEB_AUTOMATION_SAVE_FAILURE_SCREENSHOT: String(
      options.saveFailureScreenshot,
    ),
  });
}
