import { sha256Hex } from "./sha256.js";

function field(record, snakeCaseKey, camelCaseKey) {
  const value = record?.[snakeCaseKey] ?? record?.[camelCaseKey];
  return typeof value === "string" ? value : "";
}

function fingerprintFromParts(parts) {
  return normalizeFingerprint(parts.join(" | "));
}

export function normalizeFingerprint(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s|]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function createFingerprintHash(value) {
  return sha256Hex(normalizeFingerprint(value));
}

export function buildClusterFingerprint(cluster) {
  return fingerprintFromParts([
    field(cluster, "target_customer", "targetCustomer"),
    field(cluster, "problem", "recurringProblem"),
    field(cluster, "why_now", "whyNow"),
  ]);
}

export function buildIdeaFingerprint(idea) {
  const offer = field(idea, "offer", "offer");
  const deliveryMechanism =
    field(idea, "delivery_mechanism", "deliveryMechanism") || offer;
  const pricingModel =
    field(idea, "pricing_model", "pricingModel") ||
    field(idea, "initial_price", "initialPrice");

  return fingerprintFromParts([
    field(idea, "target_customer", "targetCustomer"),
    field(idea, "problem", "problem"),
    offer,
    deliveryMechanism,
    pricingModel,
  ]);
}

export function fingerprintIdea(idea) {
  const fingerprint = buildIdeaFingerprint(idea);

  return {
    fingerprint,
    fingerprint_hash: createFingerprintHash(fingerprint),
  };
}
