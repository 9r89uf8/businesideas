import {
  abandonVerifiedCapability,
  authorizeCollectorRun,
  releaseVerifiedCapability,
  requireValidPermission,
} from "./preflight.js";
import { isXForYouSafetyError } from "./errors.js";
import { safeErrorFields } from "./logging.js";
import { resolveCollectorRuntimeOptions } from "./runtime-options.js";

export const COLLECTOR_COMMAND_MODES = Object.freeze({
  CHECK: "check",
  COLLECT: "collect",
});

export function parseCollectorArguments(argv = []) {
  if (argv.length === 0) return COLLECTOR_COMMAND_MODES.COLLECT;
  if (argv.length === 1 && argv[0] === "--check") {
    return COLLECTOR_COMMAND_MODES.CHECK;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return "help";
  }
  throw new TypeError("Unsupported X web collector arguments.");
}

export async function executeCollectorCommand({
  mode,
  env = process.env,
  repositoryRoot = process.cwd(),
  log = () => {},
  now = new Date(),
  loadRunner = () => import("./runner.js"),
} = {}) {
  if (mode === COLLECTOR_COMMAND_MODES.CHECK) {
    try {
      await requireValidPermission({ env, repositoryRoot, now });
      log("PERMISSION_APPROVED");
      return Object.freeze({ exitCode: 0, status: "approved" });
    } catch (error) {
      log("PERMISSION_DENIED", safeErrorFields(error));
      return Object.freeze({
        exitCode: isXForYouSafetyError(error) ? 2 : 1,
        status: "denied",
        errorCode: safeErrorFields(error).errorCode,
      });
    }
  }

  if (mode !== COLLECTOR_COMMAND_MODES.COLLECT) {
    throw new TypeError("Unknown X web collector command mode.");
  }

  let options;
  try {
    // Runtime options are validated before consuming a daily run allowance.
    options = resolveCollectorRuntimeOptions(env);
  } catch (error) {
    log("PERMISSION_DENIED", safeErrorFields(error));
    return Object.freeze({
      exitCode: 2,
      status: "denied",
      errorCode: "CONFIG_INVALID",
    });
  }

  let capability;
  let outcome;
  let primaryError = null;

  try {
    capability = await authorizeCollectorRun({ env, repositoryRoot, now });

    // No module on the static path above imports Playwright. This callback is
    // invoked only after the flag/account gate and profile lock succeed.
    const runner = await loadRunner();
    outcome = await runner.runAuthorizedCollector({
      capability,
      env,
      options,
      log,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    if (capability) {
      try {
        if (
          primaryError?.code === "BROWSER_CLOSE_FAILED" ||
          primaryError?.code === "BROWSER_LAUNCH_ALREADY_CLAIMED"
        ) {
          // Chrome may still own the persistent profile. Revoke this process's
          // capability but strand the lock so every later run fails closed
          // until an operator verifies shutdown and removes it.
          abandonVerifiedCapability(capability);
        } else {
          await releaseVerifiedCapability(capability);
        }
      } catch (error) {
        // A stranded profile lock is the most actionable terminal condition;
        // surface it even when the run had already recorded another failure.
        primaryError = error;
      }
    }
  }

  if (primaryError) {
    const fields = safeErrorFields(primaryError);
    log(
      isXForYouSafetyError(primaryError) ? "PERMISSION_DENIED" : "RUN_FAILED",
      fields,
    );
    return Object.freeze({
      exitCode: isXForYouSafetyError(primaryError) ? 2 : 1,
      status: "failed",
      errorCode: fields.errorCode,
    });
  }

  return Object.freeze({ exitCode: 0, status: "completed", outcome });
}
