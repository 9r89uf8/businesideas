import { randomUUID as nodeRandomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { dirname } from "node:path";
import {
  X_FOR_YOU_ERROR_CODES,
  XForYouSafetyError,
} from "./errors.js";

const activeProfileLocks = new WeakMap();

function lockError(code, message) {
  return new XForYouSafetyError(code, message);
}

function resolveNow(now) {
  const supplied = typeof now === "function" ? now() : now;
  const date = supplied instanceof Date
    ? new Date(supplied.getTime())
    : new Date(supplied);
  if (!Number.isFinite(date.getTime())) {
    throw lockError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The X web automation clock is invalid.",
    );
  }
  return date;
}

async function removeOwnedLock(state) {
  let payload;
  try {
    payload = JSON.parse(await state.fs.readFile(state.lockFilePath, "utf8"));
  } catch {
    throw lockError(
      X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID,
      "The X browser profile lock could not be safely released.",
    );
  }

  if (payload?.ownerToken !== state.ownerToken) {
    throw lockError(
      X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID,
      "The X browser profile lock could not be safely released.",
    );
  }

  try {
    await state.fs.unlink(state.lockFilePath);
  } catch {
    throw lockError(
      X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID,
      "The X browser profile lock could not be safely released.",
    );
  }
}

export function assertActiveProfileLock(profileLock) {
  const state = profileLock && activeProfileLocks.get(profileLock);
  if (!state || state.released) {
    throw lockError(
      X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID,
      "An active X browser profile lock is required.",
    );
  }
  return true;
}

export async function releaseProfileLock(profileLock) {
  assertActiveProfileLock(profileLock);
  const state = activeProfileLocks.get(profileLock);

  // Invalidate the in-process capability before asynchronous cleanup. Even if
  // cleanup fails, this process may no longer use the profile under this lock.
  state.released = true;
  activeProfileLocks.delete(profileLock);
  await removeOwnedLock(state);
}

/**
 * Acquires a fail-closed, process-independent lock using an exclusive create.
 * Stale locks are never deleted automatically because doing so could permit two
 * Chrome processes to corrupt the same persistent profile.
 */
export async function acquireProfileLock({
  lockFilePath,
  now = new Date(),
  fs = nodeFs,
  randomUUID = nodeRandomUUID,
  processId = process.pid,
} = {}) {
  if (typeof lockFilePath !== "string" || !lockFilePath) {
    throw lockError(
      X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      "The X browser profile lock configuration is invalid.",
    );
  }

  const acquiredAt = resolveNow(now).toISOString();
  const ownerToken = randomUUID();
  let fileHandle;

  try {
    await fs.mkdir(dirname(lockFilePath), { recursive: true, mode: 0o700 });
    fileHandle = await fs.open(lockFilePath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw lockError(
        X_FOR_YOU_ERROR_CODES.PROFILE_LOCKED,
        "The dedicated X browser profile is already in use.",
      );
    }
    throw lockError(
      X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID,
      "The X browser profile lock could not be acquired.",
    );
  }

  try {
    await fileHandle.writeFile(`${JSON.stringify({
      version: 1,
      ownerToken,
      processId: Number.isSafeInteger(processId) ? processId : null,
      acquiredAt,
    })}\n`, { encoding: "utf8" });
    await fileHandle.sync();
    await fileHandle.close();
  } catch {
    try {
      await fileHandle?.close();
    } catch {
      // Cleanup remains best effort; the acquisition still fails closed.
    }
    try {
      await fs.unlink(lockFilePath);
    } catch {
      // A leftover lock intentionally blocks subsequent profile use.
    }
    throw lockError(
      X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID,
      "The X browser profile lock could not be acquired.",
    );
  }

  const profileLock = Object.freeze({ acquiredAt });
  activeProfileLocks.set(profileLock, {
    fs,
    lockFilePath,
    ownerToken,
    released: false,
  });
  return profileLock;
}
