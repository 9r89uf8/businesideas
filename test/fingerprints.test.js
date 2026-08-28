import assert from "node:assert/strict";
import test from "node:test";

import {
  buildClusterFingerprint,
  buildIdeaFingerprint,
  createFingerprintHash,
  fingerprintIdea,
  normalizeFingerprint,
} from "../src/lib/fingerprints.js";

test("normalizes fingerprints while preserving Unicode letters, numbers, and pipes", () => {
  assert.equal(
    normalizeFingerprint("  Café & Co. | AI-review?!  | Fixed-fee  "),
    "café co | aireview | fixedfee",
  );
  assert.equal(normalizeFingerprint(null), "");
});

test("hashes the normalized fingerprint", () => {
  assert.equal(
    createFingerprintHash("Café & Co | AI review"),
    createFingerprintHash("café co | ai review"),
  );
  assert.match(createFingerprintHash("one idea"), /^[a-f0-9]{64}$/);
  assert.notEqual(createFingerprintHash("one idea"), createFingerprintHash("another idea"));
});

test("builds cluster and idea fingerprints from the plan fields", () => {
  assert.equal(
    buildClusterFingerprint({
      target_customer: "Small Accounting Firms",
      problem: "Unreliable AI review",
      why_now: "Adoption is ahead of controls",
    }),
    "small accounting firms | unreliable ai review | adoption is ahead of controls",
  );

  const idea = {
    target_customer: "Accounting firms",
    problem: "AI quality control",
    offer: "Fixed-fee audit",
    initial_price: "$2,500 setup",
  };

  assert.equal(
    buildIdeaFingerprint(idea),
    "accounting firms | ai quality control | fixedfee audit | fixedfee audit | 2500 setup",
  );

  const result = fingerprintIdea(idea);
  assert.equal(result.fingerprint, buildIdeaFingerprint(idea));
  assert.equal(result.fingerprint_hash, createFingerprintHash(result.fingerprint));
});

test("uses explicit delivery and pricing fields when supplied", () => {
  assert.equal(
    buildIdeaFingerprint({
      targetCustomer: "Law firms",
      problem: "Document verification",
      offer: "Review setup",
      deliveryMechanism: "On-site workshop",
      pricingModel: "Fixed fee",
    }),
    "law firms | document verification | review setup | onsite workshop | fixed fee",
  );
});
