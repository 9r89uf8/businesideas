import { randomUUID as nodeRandomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  X_FOR_YOU_ERROR_CODES,
  XForYouSafetyError,
  isXForYouSafetyError,
} from "./errors.js";
import {
  acquireProfileLock,
  assertActiveProfileLock,
  releaseProfileLock,
} from "./profile-lock.js";

const X_HANDLE_PATTERN = /^@[A-Za-z0-9_]{1,15}$/;
const DEFAULT_REPOSITORY_ROOT = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const activeVerifiedCapabilities = new WeakMap();
const issuedVerifiedCapabilities = new WeakSet();

function preflightError(code, message) {
  return new XForYouSafetyError(code, message);
}

function requireNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveAuthorizationBoundary(env) {
  if (env?.X_WEB_AUTOMATION_ENABLED !== "true") {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED,
      "X web automation is disabled.",
    );
  }

  const configuredAccount = requireNonEmptyString(env.X_LOGIN_USERNAME);
  const approvedAccount = requireNonEmptyString(
    env.X_WEB_AUTOMATION_APPROVED_ACCOUNT,
  );
  if (!configuredAccount || !X_HANDLE_PATTERN.test(configuredAccount)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The configured X account is invalid.",
    );
  }
  if (!approvedAccount || !X_HANDLE_PATTERN.test(approvedAccount)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The approved X account is invalid.",
    );
  }
  if (approvedAccount.toLowerCase() !== configuredAccount.toLowerCase()) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.APPROVED_ACCOUNT_MISMATCH,
      "The approved X account does not match the configured account.",
    );
  }

  return Object.freeze({ configuredAccount, approvedAccount });
}

function hasUnsafeBrowserDebugEnvironment(env) {
  return Object.entries(env || {}).some(([name, value]) => {
    if (!requireNonEmptyString(value)) return false;
    const normalizedName = name.toUpperCase();
    return (
      /^(?:DEBUG|DEBUG_FILE)$/.test(normalizedName) ||
      (normalizedName.startsWith("PW") && normalizedName !== "PWD") ||
      normalizedName.startsWith("PLAYWRIGHT_") ||
      /^npm_(?:config|package_config)_pwdebug$/i.test(name)
    );
  });
}

export function assertSafeBrowserEnvironment(env = process.env) {
  if (hasUnsafeBrowserDebugEnvironment(env)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "Ambient browser debugging must be disabled for X web automation.",
    );
  }
  return true;
}

function usesDeviceOrNetworkNamespace(value) {
  return (
    typeof value === "string" &&
    (value.startsWith("\\\\") || value.startsWith("//"))
  );
}

function requireAbsoluteExternalPath({
  value,
  repositoryRoot,
  pathApi,
}) {
  const candidate = requireNonEmptyString(value);
  if (
    !candidate ||
    !pathApi.isAbsolute(candidate) ||
    usesDeviceOrNetworkNamespace(candidate)
  ) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "An absolute external X web automation path is required.",
    );
  }

  const normalized = pathApi.resolve(candidate);
  if (pathIsWithin(repositoryRoot, normalized, pathApi)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "X web automation runtime files must remain outside the repository.",
    );
  }
  return normalized;
}

function resolvePerUserRoot(pathApi) {
  if (process.platform !== "win32") return null;
  const perUserRoot = process.env.LOCALAPPDATA;
  if (
    !perUserRoot ||
    !pathApi.isAbsolute(perUserRoot) ||
    usesDeviceOrNetworkNamespace(perUserRoot)
  ) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "A local per-user runtime root is required.",
    );
  }
  return pathApi.resolve(perUserRoot);
}

function requirePerUserRuntimeDirectory(
  runtimeDirectory,
  pathApi,
  perUserRoot = resolvePerUserRoot(pathApi),
) {
  if (perUserRoot === null) {
    if (usesDeviceOrNetworkNamespace(runtimeDirectory)) {
      throw preflightError(
        X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
        "The X web automation runtime must use a local filesystem.",
      );
    }
    return;
  }
  const runtimeRelative = pathApi.relative(perUserRoot, runtimeDirectory);
  if (
    runtimeRelative === "" ||
    !pathIsWithin(perUserRoot, runtimeDirectory, pathApi) ||
    usesDeviceOrNetworkNamespace(runtimeDirectory)
  ) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "The X web automation runtime must be inside the local per-user data directory.",
    );
  }
}

function pathIsWithin(repositoryRoot, candidate, pathApi = nodePath) {
  const relative = pathApi.relative(repositoryRoot, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative))
  );
}

function parseRequestedPostLimit(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The requested X post limit is invalid.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The requested X post limit is invalid.",
    );
  }
  return parsed;
}

/**
 * Resolves only non-secret collector configuration. Password and email values
 * are intentionally outside this subsystem.
 */
export function resolvePreflightConfig({
  env = process.env,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  pathApi = nodePath,
} = {}) {
  const { configuredAccount, approvedAccount } =
    resolveAuthorizationBoundary(env);

  // Playwright's ambient debug controls can disable its normal timeouts and
  // emit action arguments (including filled credentials) through a logger we
  // do not control. This dedicated collector therefore refuses to import
  // Playwright while any of those controls are present.
  assertSafeBrowserEnvironment(env);

  if (!pathApi.isAbsolute(repositoryRoot)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The repository path configuration is invalid.",
    );
  }
  const normalizedRepositoryRoot = pathApi.resolve(repositoryRoot);

  const requestedPostLimit = parseRequestedPostLimit(
    env.X_WEB_AUTOMATION_POST_LIMIT,
  );
  const runtimeDirectory = requireAbsoluteExternalPath({
    value: env.X_WEB_AUTOMATION_RUNTIME_DIR,
    repositoryRoot: normalizedRepositoryRoot,
    pathApi,
  });
  requirePerUserRuntimeDirectory(runtimeDirectory, pathApi);

  const runtimePaths = Object.freeze({
    runtimeDirectory,
    profileDirectory: pathApi.join(runtimeDirectory, "chrome-profile"),
    lockDirectory: pathApi.join(runtimeDirectory, "locks"),
    profileLockFile: pathApi.join(
      runtimeDirectory,
      "locks",
      "chrome-profile.lock",
    ),
    outputDirectory: pathApi.join(runtimeDirectory, "output"),
  });

  return Object.freeze({
    repositoryRoot: normalizedRepositoryRoot,
    configuredAccount,
    approvedAccount,
    requestedPostLimit,
    runtimePaths,
  });
}

async function ensureExternalDirectory({
  fs,
  directory,
  canonicalRepositoryRoot,
  pathApi,
}) {
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "The external X web automation runtime directory is unavailable.",
    );
  }

  let canonicalDirectory;
  try {
    canonicalDirectory = await fs.realpath(directory);
  } catch {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "The external X web automation runtime directory is unavailable.",
    );
  }
  if (pathIsWithin(canonicalRepositoryRoot, canonicalDirectory, pathApi)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
      "X web automation runtime files must remain outside the repository.",
    );
  }
  return canonicalDirectory;
}

function resolveNow(now) {
  const supplied = typeof now === "function" ? now() : now;
  const date = supplied instanceof Date
    ? new Date(supplied.getTime())
    : new Date(supplied);
  if (!Number.isFinite(date.getTime())) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The X web automation clock is invalid.",
    );
  }
  return date;
}

export async function requireValidPermission({
  env = process.env,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  now = new Date(),
  fs = nodeFs,
  pathApi = nodePath,
} = {}) {
  const config = resolvePreflightConfig({ env, repositoryRoot, pathApi });
  let canonicalRepositoryRoot;
  try {
    canonicalRepositoryRoot = await fs.realpath(config.repositoryRoot);
  } catch {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The repository path configuration is invalid.",
    );
  }
  let canonicalPerUserRoot;
  const perUserRoot = resolvePerUserRoot(pathApi);
  if (perUserRoot !== null) {
    try {
      canonicalPerUserRoot = await fs.realpath(perUserRoot);
    } catch {
      throw preflightError(
        X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
        "The local per-user runtime root is unavailable.",
      );
    }
  } else {
    canonicalPerUserRoot = null;
  }

  const checkedAt = resolveNow(now);

  // Runtime directories are created only after the flag/account gate passes.
  // Retain their canonical paths so later browser/output operations do not
  // intentionally return to a configured junction or symlink spelling.
  const runtimeDirectory = await ensureExternalDirectory({
    fs,
    directory: config.runtimePaths.runtimeDirectory,
    canonicalRepositoryRoot,
    pathApi,
  });
  requirePerUserRuntimeDirectory(
    runtimeDirectory,
    pathApi,
    canonicalPerUserRoot,
  );
  const canonicalChildren = {};
  for (const [key, directory] of [
    ["profileDirectory", config.runtimePaths.profileDirectory],
    ["lockDirectory", config.runtimePaths.lockDirectory],
    ["outputDirectory", config.runtimePaths.outputDirectory],
  ]) {
    const canonicalDirectory = await ensureExternalDirectory({
      fs,
      directory,
      canonicalRepositoryRoot,
      pathApi,
    });
    if (
      pathApi.relative(runtimeDirectory, canonicalDirectory) === "" ||
      !pathIsWithin(runtimeDirectory, canonicalDirectory, pathApi)
    ) {
      throw preflightError(
        X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE,
        "X web automation runtime directories must remain inside the runtime root.",
      );
    }
    canonicalChildren[key] = canonicalDirectory;
  }

  const canonicalRuntimePaths = Object.freeze({
    runtimeDirectory,
    profileDirectory: canonicalChildren.profileDirectory,
    lockDirectory: canonicalChildren.lockDirectory,
    profileLockFile: pathApi.join(
      canonicalChildren.lockDirectory,
      pathApi.basename(config.runtimePaths.profileLockFile),
    ),
    outputDirectory: canonicalChildren.outputDirectory,
  });
  const canonicalConfig = Object.freeze({
    ...config,
    runtimePaths: canonicalRuntimePaths,
  });

  return Object.freeze({
    config: canonicalConfig,
    checkedAt: checkedAt.toISOString(),
  });
}

export async function authorizeCollectorRun({
  env = process.env,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  now = new Date(),
  fs = nodeFs,
  pathApi = nodePath,
  randomUUID = nodeRandomUUID,
} = {}) {
  const permission = await requireValidPermission({
    env,
    repositoryRoot,
    now,
    fs,
    pathApi,
  });
  const authorizedAt = new Date(permission.checkedAt);
  let profileLock;

  try {
    profileLock = await acquireProfileLock({
      lockFilePath: permission.config.runtimePaths.profileLockFile,
      now: authorizedAt,
      fs,
      randomUUID,
    });
    const context = Object.freeze({
      configuredAccount: permission.config.configuredAccount,
      approvedAccount: permission.config.approvedAccount,
      requestedPostLimit: permission.config.requestedPostLimit,
      runtimePaths: permission.config.runtimePaths,
      runId: randomUUID(),
      startedAt: authorizedAt.toISOString(),
    });
    const capability = Object.freeze({});
    issuedVerifiedCapabilities.add(capability);
    activeVerifiedCapabilities.set(capability, {
      context,
      profileLock,
      authorizationEnv: env,
      browserLaunchClaimed: false,
    });
    return capability;
  } catch (error) {
    if (profileLock) {
      try {
        await releaseProfileLock(profileLock);
      } catch {
        // Preserve the original bounded failure. A remaining lock fails closed.
      }
    }
    if (isXForYouSafetyError(error)) throw error;
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The X web automation runtime could not be authorized.",
    );
  }
}

/**
 * Browser launchers must call this immediately before importing or launching
 * Chromium. A lookalike object cannot pass because membership is module-private.
 */
export function assertVerifiedCapability(capability) {
  const state = capability && activeVerifiedCapabilities.get(capability);
  if (!state || !issuedVerifiedCapabilities.has(capability)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED,
      "A verified X web automation capability is required.",
    );
  }
  assertActiveProfileLock(state.profileLock);
  const activeAuthorization = resolveAuthorizationBoundary(
    state.authorizationEnv,
  );
  if (
    activeAuthorization.configuredAccount.toLowerCase() !==
      state.context.configuredAccount.toLowerCase() ||
    activeAuthorization.approvedAccount.toLowerCase() !==
      state.context.approvedAccount.toLowerCase()
  ) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.APPROVED_ACCOUNT_MISMATCH,
      "The approved X account changed after this run was authorized.",
    );
  }
  return state.context;
}

/** Atomically consume the one browser-launch claim carried by a run slot. */
export function claimVerifiedCapabilityForBrowserLaunch(capability) {
  const context = assertVerifiedCapability(capability);
  const state = activeVerifiedCapabilities.get(capability);
  if (state.browserLaunchClaimed) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.BROWSER_LAUNCH_ALREADY_CLAIMED,
      "This X collector run has already attempted its browser launch.",
    );
  }
  state.browserLaunchClaimed = true;
  return context;
}

export async function releaseVerifiedCapability(capability) {
  if (!issuedVerifiedCapabilities.has(capability)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED,
      "A verified X web automation capability is required.",
    );
  }

  const state = activeVerifiedCapabilities.get(capability);
  if (!state) return false;
  activeVerifiedCapabilities.delete(capability);
  await releaseProfileLock(state.profileLock);
  return true;
}

/**
 * Revoke a capability without removing its profile lock. This is reserved for
 * the fail-closed case where Chrome did not confirm shutdown: leaving the lock
 * in place prevents another collector from sharing a possibly live profile.
 */
export function abandonVerifiedCapability(capability) {
  if (!issuedVerifiedCapabilities.has(capability)) {
    throw preflightError(
      X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED,
      "A verified X web automation capability is required.",
    );
  }

  const state = activeVerifiedCapabilities.get(capability);
  if (!state) return false;
  activeVerifiedCapabilities.delete(capability);
  return true;
}
