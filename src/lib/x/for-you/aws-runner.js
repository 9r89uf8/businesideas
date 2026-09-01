import { execFile as execFileCallback } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

import {
  COLLECTOR_COMMAND_MODES,
  executeCollectorCommand,
} from "./command.js";
import {
  X_FOR_YOU_ERROR_CODES,
  XForYouSafetyError,
} from "./errors.js";
import { safeErrorFields } from "./logging.js";
import {
  assertSafeBrowserEnvironment,
  resolvePreflightConfig,
} from "./preflight.js";

const execFileAsync = promisify(execFileCallback);
const AWS_COMMAND_TIMEOUT_MS = 30_000;
const AWS_COMMAND_MAX_BUFFER = 128 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const AWS_SECRET_ID_PATTERN = /^[A-Za-z0-9/_+=.@:-]{1,2048}$/;
const X_HANDLE_PATTERN = /^@[A-Za-z0-9_]{1,15}$/;
const COLLECTOR_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const X_POST_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const WORKFLOW_WEBHOOK_PATH_PATTERN =
  /^\/\.well-known\/workflow\/v1\/webhook\/[A-Za-z0-9_-]{16,512}$/;
const DNS_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_RESULT_URL_LENGTH = 2048;
const RESULT_DELIVERY_TIMEOUT_MS = 30_000;
const MAX_RESULT_CANDIDATES = 100;
const COLLECTOR_SECRET_KEYS = Object.freeze([
  "X_LOGIN_EMAIL",
  "X_LOGIN_PASSWORD",
  "X_LOGIN_USERNAME",
]);

const COLLECTOR_OPTION_ENV_KEYS = Object.freeze([
  "X_WEB_AUTOMATION_MAX_SCROLLS",
  "X_WEB_AUTOMATION_MAX_NO_GROWTH_CYCLES",
  "X_WEB_AUTOMATION_MAX_RUNTIME_MS",
  "X_WEB_AUTOMATION_LOAD_WAIT_MS",
  "X_WEB_AUTOMATION_STATE_TIMEOUT_MS",
  "X_WEB_AUTOMATION_MANUAL_ACTION_TIMEOUT_MS",
  "X_WEB_AUTOMATION_INCLUDE_RAW_TEXT",
  "X_WEB_AUTOMATION_SAVE_FAILURE_SCREENSHOT",
]);

const AWS_CLI_ENV_KEYS = Object.freeze([
  "AWS_CA_BUNDLE",
  "AWS_CONFIG_FILE",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SHARED_CREDENTIALS_FILE",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
]);

function cloudError(code, message) {
  return new XForYouSafetyError(code, message);
}

function requireBoundedString(value, { maximum, trim = false } = {}) {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const candidate = trim ? value.trim() : value;
  if (!candidate || candidate.length > maximum) return null;
  return candidate;
}

function requireAwsSecretId(value) {
  const candidate = requireBoundedString(value, {
    maximum: 2048,
    trim: true,
  });
  if (!candidate || !AWS_SECRET_ID_PATTERN.test(candidate)) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
      "The AWS collector configuration is invalid.",
    );
  }
  return candidate;
}

export function normalizeForYouResultUrl(value) {
  const candidate = requireBoundedString(value, {
    maximum: MAX_RESULT_URL_LENGTH,
    trim: true,
  });
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
      "The AWS collector configuration is invalid.",
    );
  }

  const hostname = url.hostname;
  const validHostname =
    hostname.length >= 4 &&
    hostname.length <= 253 &&
    !hostname.endsWith(".") &&
    !hostname.toLowerCase().endsWith(".local") &&
    hostname.toLowerCase() !== "localhost" &&
    isIP(hostname.replace(/^\[|\]$/g, "")) === 0 &&
    hostname.split(".").length >= 2 &&
    hostname.split(".").every((label) => DNS_LABEL_PATTERN.test(label));
  if (
    url.href !== candidate ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !validHostname ||
    !WORKFLOW_WEBHOOK_PATH_PATTERN.test(url.pathname)
  ) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
      "The AWS collector configuration is invalid.",
    );
  }
  return url.href;
}

export function buildAwsCliEnvironment(env = process.env) {
  const result = {};
  for (const name of AWS_CLI_ENV_KEYS) {
    const value = env?.[name];
    if (typeof value === "string" && !value.includes("\0")) {
      result[name] = value;
    }
  }
  result.AWS_CLI_AUTO_PROMPT = "off";
  result.AWS_PAGER = "";
  return Object.freeze(result);
}

export function parseAwsCollectorSecret(secretString) {
  if (
    typeof secretString !== "string" ||
    Buffer.byteLength(secretString, "utf8") > MAX_SECRET_BYTES
  ) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
      "The AWS collector secret is unavailable.",
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
      "The AWS collector secret is unavailable.",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("\0") !== COLLECTOR_SECRET_KEYS.join("\0")
  ) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
      "The AWS collector secret is unavailable.",
    );
  }

  const email = requireBoundedString(parsed?.X_LOGIN_EMAIL, {
    maximum: 512,
    trim: true,
  });
  const username = requireBoundedString(parsed?.X_LOGIN_USERNAME, {
    maximum: 16,
    trim: true,
  });
  const password = requireBoundedString(parsed?.X_LOGIN_PASSWORD, {
    maximum: 4096,
  });

  if (
    !email ||
    /[\r\n]/.test(email) ||
    !username ||
    !X_HANDLE_PATTERN.test(username) ||
    !password
  ) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
      "The AWS collector secret is unavailable.",
    );
  }

  return Object.freeze({
    email,
    username,
    password,
  });
}

async function runAwsCli(args, {
  env = process.env,
  execFile = execFileAsync,
} = {}) {
  return execFile("aws", args, {
    env: buildAwsCliEnvironment(env),
    maxBuffer: AWS_COMMAND_MAX_BUFFER,
    timeout: AWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}

export async function fetchAwsCollectorSecret({
  secretId,
  env = process.env,
  execFile = execFileAsync,
} = {}) {
  const normalizedSecretId = requireAwsSecretId(secretId);
  try {
    const result = await runAwsCli([
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      normalizedSecretId,
      "--output",
      "json",
    ], { env, execFile });
    const envelope = JSON.parse(result.stdout);
    return parseAwsCollectorSecret(envelope?.SecretString);
  } catch (error) {
    if (error?.code === X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID) {
      throw error;
    }
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_SECRET_UNAVAILABLE,
      "The AWS collector secret is unavailable.",
    );
  }
}

function buildCollectorEnvironment({ env, secret }) {
  const collectorEnv = {
    X_WEB_AUTOMATION_ENABLED: env.X_WEB_AUTOMATION_ENABLED,
    X_WEB_AUTOMATION_APPROVED_ACCOUNT:
      env.X_WEB_AUTOMATION_APPROVED_ACCOUNT,
    X_LOGIN_EMAIL: secret.email,
    X_LOGIN_USERNAME: secret.username,
    X_LOGIN_PASSWORD: secret.password,
    X_WEB_AUTOMATION_POST_LIMIT: env.X_WEB_AUTOMATION_POST_LIMIT,
    X_WEB_AUTOMATION_RUNTIME_DIR: env.X_WEB_AUTOMATION_RUNTIME_DIR,
    X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES: "false",
  };
  for (const name of COLLECTOR_OPTION_ENV_KEYS) {
    if (typeof env?.[name] === "string") collectorEnv[name] = env[name];
  }
  return Object.freeze(collectorEnv);
}

function normalizeCollectorResult(outcome) {
  const collectorRunId = outcome?.metadata?.runId;
  const sourceCandidates = outcome?.candidates;
  if (
    typeof collectorRunId !== "string" ||
    !COLLECTOR_RUN_ID_PATTERN.test(collectorRunId) ||
    !Array.isArray(sourceCandidates) ||
    sourceCandidates.length > MAX_RESULT_CANDIDATES
  ) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
      "The AWS collector result could not be delivered.",
    );
  }

  const postIds = new Set();
  const feedPositions = new Set();
  const candidates = sourceCandidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Object.keys(candidate).length !== 2 ||
      !X_POST_ID_PATTERN.test(candidate.postId || "") ||
      !Number.isInteger(candidate.feedPosition) ||
      candidate.feedPosition < 1 ||
      candidate.feedPosition > MAX_RESULT_CANDIDATES ||
      postIds.has(candidate.postId) ||
      feedPositions.has(candidate.feedPosition)
    ) {
      throw cloudError(
        X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
        "The AWS collector result could not be delivered.",
      );
    }
    postIds.add(candidate.postId);
    feedPositions.add(candidate.feedPosition);
    return Object.freeze({
      postId: candidate.postId,
      feedPosition: candidate.feedPosition,
    });
  });

  return Object.freeze({
    collectorRunId,
    candidates: Object.freeze(candidates),
  });
}

function normalizeCollectorFailure(errorCode) {
  return Object.freeze({
    status: "failed",
    errorCode: safeErrorFields({ code: errorCode }).errorCode,
    candidates: Object.freeze([]),
  });
}

export async function deliverAwsCollectorResult({
  resultUrl,
  outcome,
  errorCode,
  fetchImpl = globalThis.fetch,
  timeoutMs = RESULT_DELIVERY_TIMEOUT_MS,
} = {}) {
  const normalizedResultUrl = normalizeForYouResultUrl(resultUrl);
  const hasOutcome = outcome !== undefined;
  const hasFailure = errorCode !== undefined;
  if (hasOutcome === hasFailure) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
      "The AWS collector result could not be delivered.",
    );
  }
  const result = hasOutcome
    ? normalizeCollectorResult(outcome)
    : normalizeCollectorFailure(errorCode);
  if (
    typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RESULT_DELIVERY_TIMEOUT_MS
  ) {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
      "The AWS collector result could not be delivered.",
    );
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(normalizedResultUrl, {
      method: "POST",
      headers: Object.freeze({
        "content-type": "application/json",
      }),
      body: JSON.stringify(result),
      redirect: "error",
      cache: "no-store",
      signal: abortController.signal,
    });
    if (!response || response.status < 200 || response.status >= 300) {
      throw new Error("result rejected");
    }
    await response.body?.cancel?.().catch(() => {});
  } catch {
    throw cloudError(
      X_FOR_YOU_ERROR_CODES.AWS_RESULT_DELIVERY_FAILED,
      "The AWS collector result could not be delivered.",
    );
  } finally {
    clearTimeout(timeout);
  }
  return true;
}

export async function runAwsCollectorCommand({
  mode = COLLECTOR_COMMAND_MODES.COLLECT,
  env = process.env,
  repositoryRoot = process.cwd(),
  log = () => {},
  fetchSecret = fetchAwsCollectorSecret,
  executeCommand = executeCollectorCommand,
  deliverResult = deliverAwsCollectorResult,
} = {}) {
  let resultUrl = null;
  let deliveryAttempted = false;

  try {
    if (env?.X_WEB_AUTOMATION_ENABLED !== "true") {
      throw cloudError(
        X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED,
        "X web automation is disabled.",
      );
    }
    assertSafeBrowserEnvironment(env);
    if (
      mode !== COLLECTOR_COMMAND_MODES.CHECK &&
      mode !== COLLECTOR_COMMAND_MODES.COLLECT
    ) {
      throw cloudError(
        X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
        "The AWS collector configuration is invalid.",
      );
    }
    resultUrl = mode === COLLECTOR_COMMAND_MODES.COLLECT
      ? normalizeForYouResultUrl(env.X_FOR_YOU_RESULT_URL)
      : null;
    const secretId = requireAwsSecretId(env.X_FOR_YOU_AWS_SECRET_ID);
    const approvedAccount = requireBoundedString(
      env.X_WEB_AUTOMATION_APPROVED_ACCOUNT,
      { maximum: 16, trim: true },
    );
    if (!approvedAccount || !X_HANDLE_PATTERN.test(approvedAccount)) {
      throw cloudError(
        X_FOR_YOU_ERROR_CODES.AWS_CONFIGURATION_INVALID,
        "The AWS collector configuration is invalid.",
      );
    }
    const secret = await fetchSecret({
      secretId,
      env,
    });
    const collectorEnv = buildCollectorEnvironment({
      env,
      secret,
    });

    // Resolve the flag/account gate and all non-secret options before the
    // command can dynamically reach Playwright.
    resolvePreflightConfig({
      env: collectorEnv,
      repositoryRoot,
    });

    const result = await executeCommand({
      mode,
      env: collectorEnv,
      repositoryRoot,
      log,
    });

    if (mode === COLLECTOR_COMMAND_MODES.COLLECT) {
      if (!["completed", "failed"].includes(result?.status)) {
        const error = new Error("The AWS collector returned an invalid status.");
        error.code = "COLLECTOR_FAILED";
        throw error;
      }

      deliveryAttempted = true;
      await deliverResult(
        result.status === "completed"
          ? { resultUrl, outcome: result.outcome }
          : {
              resultUrl,
              errorCode: safeErrorFields({ code: result.errorCode }).errorCode,
            },
      );
      log("CLOUD_RESULT_DELIVERED");
    }
    return result;
  } catch (error) {
    let terminalError = error;
    let fields = safeErrorFields(error);

    if (
      mode === COLLECTOR_COMMAND_MODES.COLLECT &&
      resultUrl !== null &&
      !deliveryAttempted
    ) {
      deliveryAttempted = true;
      try {
        await deliverResult({
          resultUrl,
          errorCode: fields.errorCode,
        });
        log("CLOUD_RESULT_DELIVERED");
      } catch (deliveryError) {
        terminalError = deliveryError;
        fields = safeErrorFields(deliveryError);
      }
    }

    log(
      terminalError?.code === X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED
        ? "PERMISSION_DENIED"
        : "RUN_FAILED",
      fields,
    );
    return Object.freeze({
      exitCode: terminalError instanceof XForYouSafetyError ? 2 : 1,
      status: "failed",
      errorCode: fields.errorCode,
    });
  }
}
