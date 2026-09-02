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
const CANDIDATE_IDS = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
];

function candidate(candidateId, postId, score = 80) {
  return {
    candidate_id: candidateId,
    source_post: {
      post_id: postId,
      author_id: `author-${postId}`,
      author_username: `user${postId}`,
      url: `https://x.com/user${postId}/status/${postId}`,
      x_created_at: "2026-08-28T12:00:00.000Z",
      text: `Source post ${postId} describes a recurring manual workflow.`,
      context: { links: [] },
      metrics: { views: 100_000, comments: 50, likes: 100, saves: 10 },
    },
    selected_idea: {
      title: `Candidate ${postId}`,
      business_form: "software",
      payer: "Small businesses",
      user: "Operations managers",
      problem_or_opportunity: "A recurring manual workflow",
      product: "A self-serve web app that completes the workflow",
      how_the_post_enables_it: "The post identifies the workflow and a new capability.",
      why_source_product_is_not_enough: "The source capability lacks the complete workflow.",
      current_alternative: "Manual work in spreadsheets",
      payment_reason: "It saves several hours every week",
      pricing_hypothesis: "$29 per month",
      distribution: "Workflow-specific communities",
      mvp: "One input workflow, one generated output, and billing",
      largest_risk: "The incumbent could add this workflow",
      score,
    },
  };
}

function jobPayload() {
  return buildResearchJobPayload({
    runId: RUN_ID,
    researchAsOf: "2026-08-29T00:00:00.000Z",
    candidates: [
      candidate(CANDIDATE_IDS[0], "1"),
      candidate(CANDIDATE_IDS[1], "4"),
    ],
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

function idea(rank, candidateId, postId, sourceId, claim) {
  return {
    rank,
    candidate_id: candidateId,
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
    source_post_ids: [postId],
    research_source_ids: [sourceId],
    claim_source_map: [{ claim, research_source_ids: [sourceId] }],
  };
}

function validResult() {
  const firstClaim = "A public API supports the required operation.";
  const secondClaim = "The workflow can be delivered through a web app.";
  return {
    schema_version: PIPELINE.research.schemaVersion,
    assessment: { overall_evidence: "strong", notes: "Two grounded candidates." },
    sources: [
      source("web-1", "api", firstClaim),
      source("web-2", "workflow", secondClaim),
    ],
    ideas: [
      idea(1, CANDIDATE_IDS[0], "1", "web-1", firstClaim),
      idea(2, CANDIDATE_IDS[1], "4", "web-2", secondClaim),
    ],
  };
}

function runPosts() {
  return ["1", "4"].map((postId) => ({
    post_id: postId,
    author_id: `author-${postId}`,
  }));
}

test("the queued product contract exposes the one-post candidate boundary", () => {
  const contract = buildResearchProductContract();
  assert.deepEqual(contract.allowed_delivery_modes, ["self_serve_web_app"]);
  assert.deepEqual(contract.allowed_sales_motions, [
    "self_serve_checkout",
    "online_trial_then_self_serve",
  ]);
  assert.equal(contract.minimum_x_posts, 1);
  assert.equal(contract.minimum_x_authors, 1);
});

test("research payloads contain versioned candidates and one exact source post", () => {
  const payload = jobPayload();
  assert.equal(payload.schema_version, PIPELINE.research.schemaVersion);
  assert.equal(payload.prompt_version, PIPELINE.research.promptVersion);
  assert.equal(payload.run_id, RUN_ID);
  assert.equal(payload.candidates.length, 2);
  assert.deepEqual(Object.keys(payload.candidates[0]).sort(), [
    "candidate_id",
    "selected_idea",
    "source_post",
  ]);
  assert.equal(payload.candidates[0].source_post.post_id, "1");
  assert.equal(payload.candidates[0].selected_idea.business_form, "software");
  assert.equal("clusters" in payload, false);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(payload)).byteLength <=
      PIPELINE.research.maxResultBytes,
  );
});

test("shape validation accepts zero ideas and nullable publishers", () => {
  const normalized = validateResearchResultShape({
    schema_version: PIPELINE.research.schemaVersion,
    assessment: { overall_evidence: "insufficient", notes: "No strong idea." },
    sources: [source("web-1", "one", "A supported claim.")],
    ideas: [],
  });
  assert.equal(normalized.sources[0].publisher, null);
  assert.deepEqual(normalized.ideas, []);
});

test("shape validation rejects unsafe URLs, bad ranks, and repeated candidate IDs", () => {
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

  const repeatedCandidate = validResult();
  repeatedCandidate.ideas[1].candidate_id = CANDIDATE_IDS[0];
  assert.throws(() => validateResearchResultShape(repeatedCandidate), /candidate IDs must be unique/);
});

test("candidate or source mismatches are discarded without losing valid siblings", () => {
  const payload = jobPayload();
  const wrongCandidate = validResult();
  wrongCandidate.ideas[0].candidate_id = "candidate-not-in-payload";
  const candidateValidated = validateResearchResult(
    wrongCandidate,
    payload,
    runPosts(),
  );
  assert.deepEqual(candidateValidated.ideas.map((item) => item.title), ["Idea 2"]);

  const wrongPost = validResult();
  wrongPost.ideas[0].source_post_ids = ["4"];
  const postValidated = validateResearchResult(wrongPost, payload, runPosts());
  assert.deepEqual(postValidated.ideas.map((item) => item.title), ["Idea 2"]);

  const badClaimMap = validResult();
  badClaimMap.ideas[0].claim_source_map[0].claim = "An unsupported claim.";
  const claimValidated = validateResearchResult(
    badClaimMap,
    payload,
    runPosts(),
  );
  assert.deepEqual(claimValidated.ideas.map((item) => item.title), ["Idea 2"]);
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
