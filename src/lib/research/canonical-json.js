import { sha256Hex } from "../sha256.js";

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Research JSON cannot contain non-finite numbers.");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new TypeError("Research JSON contains an unsupported value.");
}

export function canonicalResearchJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashResearchJson(value) {
  return sha256Hex(canonicalResearchJson(value));
}
