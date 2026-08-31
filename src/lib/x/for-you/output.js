import { open, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { normalizeExtractedPost } from "./extract-post.js";
import {
  isSafeCollectorAuthMethod,
  isSafeCollectorErrorCode,
  isSafeCollectorStopReason,
} from "./logging.js";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const X_HANDLE_PATTERN = /^@[A-Za-z0-9_]{1,15}$/;

function requireRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId || "")) {
    throw new TypeError("A valid run ID is required for collector output.");
  }
}

export function sanitizePostOutput(post) {
  requireRunId(post?.runId);
  const normalized = normalizeExtractedPost(post, {
    includeRawText: Object.hasOwn(post || {}, "rawAccessibleText"),
  });
  const observedAt =
    typeof post?.observedAt === "string" &&
    Number.isFinite(Date.parse(post.observedAt))
      ? new Date(post.observedAt).toISOString()
      : null;

  if (
    !normalized ||
    !observedAt ||
    !Number.isSafeInteger(post?.feedPosition) ||
    post.feedPosition <= 0
  ) {
    throw new TypeError("The X collector post output is invalid.");
  }

  return {
    runId: post.runId,
    ...normalized,
    observedAt,
    feedPosition: post.feedPosition,
  };
}

export function sanitizeRunMetadata(metadata) {
  requireRunId(metadata?.runId);
  const startedAt = typeof metadata?.startedAt === "string"
    ? new Date(metadata.startedAt)
    : null;
  const completedAt = typeof metadata?.completedAt === "string"
    ? new Date(metadata.completedAt)
    : null;
  const requestedPosts = metadata?.requestedPosts;
  const uniquePosts = metadata?.uniquePosts;
  const scrollCycles = metadata?.scrollCycles;

  if (
    !X_HANDLE_PATTERN.test(metadata?.approvedAccount || "") ||
    !startedAt ||
    !Number.isFinite(startedAt.getTime()) ||
    !completedAt ||
    !Number.isFinite(completedAt.getTime()) ||
    completedAt < startedAt ||
    !Number.isSafeInteger(requestedPosts) ||
    requestedPosts < 1 ||
    requestedPosts > 100 ||
    !Number.isSafeInteger(uniquePosts) ||
    uniquePosts < 0 ||
    uniquePosts > requestedPosts ||
    !Number.isSafeInteger(scrollCycles) ||
    scrollCycles < 0 ||
    scrollCycles > 200 ||
    !isSafeCollectorStopReason(metadata?.stopReason) ||
    !(
      metadata?.authenticatedUsing === null ||
      isSafeCollectorAuthMethod(metadata.authenticatedUsing)
    ) ||
    !(
      metadata?.failureCategory === null ||
      isSafeCollectorErrorCode(metadata?.failureCategory)
    )
  ) {
    throw new TypeError("The X collector run metadata is invalid.");
  }

  return {
    runId: metadata.runId,
    approvedAccount: metadata.approvedAccount,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    requestedPosts,
    uniquePosts,
    scrollCycles,
    stopReason: metadata.stopReason,
    authenticatedUsing: metadata.authenticatedUsing,
    failureCategory: metadata.failureCategory,
  };
}

export async function createJsonlOutput({ outputDirectory, runId }) {
  requireRunId(runId);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const fileName = `${runId}.posts.jsonl`;
  const filePath = path.join(outputDirectory, fileName);
  const handle = await open(filePath, "wx", 0o600);
  let closed = false;

  return Object.freeze({
    fileName,
    filePath,
    async writePost(post) {
      if (closed) throw new Error("The collector output is already closed.");
      await handle.write(
        `${JSON.stringify(sanitizePostOutput(post))}\n`,
        null,
        "utf8",
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      let failure = null;
      try {
        await handle.sync();
      } catch (error) {
        failure = error;
      }
      try {
        await handle.close();
      } catch (error) {
        failure ||= error;
      }
      if (failure) throw failure;
    },
  });
}

export async function writeRunMetadata({ outputDirectory, runId, metadata }) {
  requireRunId(runId);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const fileName = `${runId}.run.json`;
  const filePath = path.join(outputDirectory, fileName);
  const temporaryPath = path.join(outputDirectory, `.${runId}.run.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  let failure = null;

  try {
    await handle.write(
      `${JSON.stringify(sanitizeRunMetadata(metadata), null, 2)}\n`,
      null,
      "utf8",
    );
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      failure ||= error;
    }
  }

  if (failure) {
    await unlink(temporaryPath).catch(() => {});
    throw failure;
  }

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return Object.freeze({ fileName, filePath });
}
