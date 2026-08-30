import assert from "node:assert/strict";
import { test } from "node:test";

import { PIPELINE } from "../src/lib/config.js";
import {
  buildResearchJobPayload,
  buildResearchProductContract,
} from "../src/lib/prompts/generate-ideas.js";
import { normalizePublicResearchUrl } from "../src/lib/research/public-url.js";
import {
  validateResearchResult,
  validateResearchResultShape,
} from "../src/lib/validation.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const CLUSTER_IDS = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
];

function evidence(postId, authorId, score) {
  return {
    post_id: postId,
    author_id: authorId,
    author_username: `user${authorId}`,
    url: `https://x.com/user${authorId}/status/${postId}`,
    x_created_at: "2026-08-28T12:00:00.000Z",
    signal_type: "pain",
    evidence_excerpt: `Evidence ${postId}`,
    metrics: { views: 100_000, comments: 50, likes: 100, saves: 10 },
    opportunity_score: score,
  };
}

function cluster(clusterId, firstPostId) {
  return {
    cluster_id: clusterId,
    title: `Cluster ${clusterId.at(-1)}`,
    target_customer: "Small businesses",
    problem: "A recurring manual workflow",
    why_now: "A new AI capability exists",
    summary: "Several people describe the same recurring problem.",
    evidence_strength: 80,
    payment_signal: 70,
    evidence: [
      evidence(String(firstPostId), String(firstPostId + 100), 90),
      evidence(String(firstPostId + 1), String(firstPostId + 101), 80),
      evidence(String(firstPostId + 2), String(firstPostId + 102), 70),
    ],
  };
}

function jobPayload() {
  return buildResearchJobPayload({
    runId: RUN_ID,
    researchAsOf: "2026-08-29T00:00:00.000Z",
    clusters: [cluster(CLUSTER_IDS[0], 1), cluster(CLUSTER_IDS[1], 4)],
  });
}

function source(sourceId, path, claim) {
  return {
    source_id: sourceId,
    url: `https://example.com/${path}`,
    title: `Source ${sourceId}`,
    publisher: null,
    published_at: null,
    accessed_at: "2026-08-29T00:00:00.000Z",
    source_type: "feasibility",
    supported_claims: [claim],
  };
}

function idea(rank, clusterId, postIds, sourceId, claim) {
  return {
    rank,
    cluster_id: clusterId,
    title: `Idea ${rank}`,
    target_customer: "Small businesses",
    problem: "A recurring manual workflow",
    offer: "A self-serve web app that completes the workflow",
    why_pay: "It saves several hours every week",
    why_now: "The required AI capability recently became practical",
    initial_price: "$29 per month",
    differentiation: "A narrow workflow and distribution wedge",
    speed_to_first_revenue: "A paid pilot can start within two weeks",
    validation_plan: "Recruit ten users and require three paid conversions",
    product_spec: {
      archetype: "specific_action_tool",
      core_action: "Complete and export the recurring workflow",
      value_mechanisms: ["save_time"],
      delivery_mode: "self_serve_web_app",
      sales_motion: "self_serve_checkout",
      business_model: "subscription",
      mvp_scope: "One input workflow, one generated output, and billing",
      mvp_build_weeks: 4,
      recurring_trigger: "The customer's weekly reporting deadline",
      latam_fit: "adaptable",
      latam_rationale: "The same small-business workflow occurs in LATAM",
    },
    hard_filter_checks: {
      website_deliverable: true,
      self_serve_without_call: true,
      solo_mvp_feasible: true,
      recurring_use: true,
      creates_allowed_value: true,
      specific_action_not_chat: true,
      no_hardware: true,
      no_healthcare_therapy_or_medical: true,
      no_consulting_agency_audit_or_workshop: true,
      no_custom_implementation: true,
      no_enterprise_sales: true,
      no_translation: true,
      no_generic_chat_or_companion: true,
    },
    risks: ["The incumbent could add this workflow"],
    assumptions: ["Customers repeat the workflow weekly"],
    evidence_score: 80,
    source_post_ids: postIds,
    research_source_ids: [sourceId],
    claim_source_map: [{ claim, research_source_ids: [sourceId] }],
  };
}

function validResult() {
  const firstClaim = "A public API supports the required operation.";
  const secondClaim = "The workflow can be delivered through a web app.";
  return {
    schema_version: 1,
    assessment: { overall_evidence: "strong", notes: "Two grounded candidates." },
    sources: [
      source("web-1", "api", firstClaim),
      source("web-2", "workflow", secondClaim),
    ],
    ideas: [
      idea(1, CLUSTER_IDS[0], ["1", "2", "3"], "web-1", firstClaim),
      idea(2, CLUSTER_IDS[1], ["4", "5", "6"], "web-2", secondClaim),
    ],
  };
}

function runPosts() {
  return [1, 2, 3, 4, 5, 6].map((postId) => ({
    post_id: String(postId),
    author_id: String(postId + 100),
  }));
}

test("the queued product contract exposes only actually publishable delivery modes", () => {
  const contract = buildResearchProductContract();
  assert.deepEqual(contract.allowed_delivery_modes, ["self_serve_web_app"]);
  assert.deepEqual(contract.allowed_sales_motions, [
    "self_serve_checkout",
    "online_trial_then_self_serve",
  ]);
  assert.ok(contract.allowed_product_archetypes.length > 0);
  assert.ok(contract.allowed_business_models.length > 0);
  assert.ok(contract.allowed_latam_fits.length > 0);
});

test("research payloads are bounded, contain exact evidence metadata, and omit raw pools", () => {
  const payload = jobPayload();
  assert.equal(payload.schema_version, PIPELINE.research.schemaVersion);
  assert.equal(payload.prompt_version, PIPELINE.research.promptVersion);
  assert.equal(payload.run_id, RUN_ID);
  assert.equal(payload.clusters.length, 2);
  assert.equal(payload.clusters[0].evidence.length, 3);
  assert.deepEqual(
    Object.keys(payload.clusters[0].evidence[0]).sort(),
    [
      "author_id",
      "author_username",
      "evidence_excerpt",
      "metrics",
      "opportunity_score",
      "post_id",
      "signal_type",
      "url",
      "x_created_at",
    ].sort(),
  );
  assert.equal("raw_posts" in payload, false);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(payload)).byteLength <=
      PIPELINE.research.maxResultBytes,
  );
});

test("shape validation accepts zero ideas and nullable publishers", () => {
  const normalized = validateResearchResultShape({
    schema_version: 1,
    assessment: { overall_evidence: "insufficient", notes: "No strong idea." },
    sources: [source("web-1", "one", "A supported claim.")],
    ideas: [],
  });
  assert.equal(normalized.sources[0].publisher, null);
  assert.deepEqual(normalized.ideas, []);
});

test("shape validation rejects unsafe or duplicate URLs and nonconsecutive ranks", () => {
  const duplicateUrls = validResult();
  duplicateUrls.sources[0].url = "https://example.com/same#first";
  duplicateUrls.sources[1].url = "https://example.com/same#second";
  assert.throws(() => validateResearchResultShape(duplicateUrls), /duplicate external source URLs/);

  const unsafeUrl = validResult();
  unsafeUrl.sources[0].url = "http://[::ffff:127.0.0.1]/metadata";
  assert.throws(() => validateResearchResultShape(unsafeUrl), /invalid external source/);

  const badRanks = validResult();
  badRanks.ideas[1].rank = 3;
  assert.throws(() => validateResearchResultShape(badRanks), /consecutive from one/);
});

test("grounding-invalid candidates are discarded without losing valid siblings", () => {
  const payload = jobPayload();
  const result = validResult();
  result.ideas[0].cluster_id = CLUSTER_IDS[1];

  const validated = validateResearchResult(result, payload, runPosts());
  assert.deepEqual(validated.ideas.map((candidate) => candidate.title), ["Idea 2"]);
  assert.deepEqual(
    validated.publishableIdeas.map((candidate) => candidate.title),
    ["Idea 2"],
  );

  const badClaimMap = validResult();
  badClaimMap.ideas[0].claim_source_map[0].claim = "An unsupported claim.";
  const claimValidated = validateResearchResult(
    badClaimMap,
    payload,
    runPosts(),
  );
  assert.deepEqual(claimValidated.ideas.map((candidate) => candidate.title), ["Idea 2"]);
});

test("public URL normalization strips fragments and rejects address aliases", () => {
  assert.equal(
    normalizePublicResearchUrl("https://Example.com/path#section"),
    "https://example.com/path",
  );
  for (const unsafe of [
    "http://localhost/path",
    "http://2130706433/path",
    "http://0x7f000001/path",
    "http://[::1]/path",
    "http://[::ffff:127.0.0.1]/path",
    "http://[2001:db8::1]/path",
    "http://[3fff::1]/path",
    "http://metadata.google.internal/path",
  ]) {
    assert.equal(normalizePublicResearchUrl(unsafe), null, unsafe);
  }
});
