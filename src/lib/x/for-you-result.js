import "server-only";

import { isSafeCollectorErrorCode } from "./for-you/logging.js";

const COLLECTOR_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const X_POST_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const SUCCESS_ROOT_KEYS = Object.freeze(["collectorRunId", "candidates"]);
const FAILURE_ROOT_KEYS = Object.freeze(["status", "errorCode", "candidates"]);
const CANDIDATE_KEYS = Object.freeze(["postId", "feedPosition"]);
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export const MAX_FOR_YOU_RESULT_BYTES = 16 * 1_024;
export const MAX_FOR_YOU_RESULT_CANDIDATES = 100;

export class ForYouResultError extends Error {
  constructor() {
    super("Invalid For You collector result.");
    this.name = "ForYouResultError";
    this.code = "INVALID_FOR_YOU_RESULT";
  }
}

function invalidResult() {
  return new ForYouResultError();
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
}

export function validateForYouResult(value) {
  if (hasExactKeys(value, FAILURE_ROOT_KEYS)) {
    if (
      value.status !== "failed" ||
      !isSafeCollectorErrorCode(value.errorCode) ||
      !Array.isArray(value.candidates) ||
      value.candidates.length !== 0
    ) {
      throw invalidResult();
    }

    return Object.freeze({
      status: "failed",
      errorCode: value.errorCode,
      candidates: Object.freeze([]),
    });
  }

  if (
    !hasExactKeys(value, SUCCESS_ROOT_KEYS) ||
    !COLLECTOR_RUN_ID_PATTERN.test(value.collectorRunId || "") ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MAX_FOR_YOU_RESULT_CANDIDATES
  ) {
    throw invalidResult();
  }

  const candidates = [];
  const postIds = new Set();
  const feedPositions = new Set();

  for (const candidate of value.candidates) {
    if (
      !hasExactKeys(candidate, CANDIDATE_KEYS) ||
      !X_POST_ID_PATTERN.test(candidate.postId || "") ||
      !Number.isInteger(candidate.feedPosition) ||
      candidate.feedPosition < 1 ||
      candidate.feedPosition > MAX_FOR_YOU_RESULT_CANDIDATES ||
      postIds.has(candidate.postId) ||
      feedPositions.has(candidate.feedPosition)
    ) {
      throw invalidResult();
    }

    postIds.add(candidate.postId);
    feedPositions.add(candidate.feedPosition);
    candidates.push({
      postId: candidate.postId,
      feedPosition: candidate.feedPosition,
    });
  }

  candidates.sort((left, right) => left.feedPosition - right.feedPosition);

  return Object.freeze({
    status: "completed",
    collectorRunId: value.collectorRunId,
    candidates: Object.freeze(
      candidates.map((candidate) => Object.freeze(candidate)),
    ),
  });
}

export function parseForYouResultText(text) {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    new TextEncoder().encode(text).byteLength > MAX_FOR_YOU_RESULT_BYTES
  ) {
    throw invalidResult();
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidResult();
  }

  return validateForYouResult(value);
}

function declaredBodyLength(request) {
  const header = request.headers.get("content-length");
  if (header === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(header)) throw invalidResult();

  const length = Number(header);
  if (
    !Number.isSafeInteger(length) ||
    length > MAX_FOR_YOU_RESULT_BYTES
  ) {
    throw invalidResult();
  }
  return length;
}

async function readBoundedRequestBody(request) {
  const declaredLength = declaredBodyLength(request);
  if (!request.body || typeof request.body.getReader !== "function") {
    throw invalidResult();
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!(value instanceof Uint8Array)) throw invalidResult();
      byteLength += value.byteLength;
      if (byteLength > MAX_FOR_YOU_RESULT_BYTES) {
        await reader.cancel().catch(() => {});
        throw invalidResult();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ForYouResultError) throw error;
    throw invalidResult();
  }

  if (
    byteLength === 0 ||
    (declaredLength !== null && declaredLength !== byteLength)
  ) {
    throw invalidResult();
  }
  return text;
}

export async function parseForYouResultRequest(request) {
  if (
    !request?.headers ||
    typeof request.headers.get !== "function" ||
    !JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "") ||
    request.headers.has("content-encoding")
  ) {
    throw invalidResult();
  }

  return parseForYouResultText(await readBoundedRequestBody(request));
}
