import assert from "node:assert/strict";
import test from "node:test";

import {
  boundIdeaGenerationClusters,
  buildGenerateIdeasPrompt,
  GENERATE_IDEAS_INSTRUCTIONS,
} from "../src/lib/prompts/generate-ideas.js";
import {
  DEFAULT_PREFERENCES,
  IDEA_HARD_FILTER_CHECKS,
  PIPELINE,
} from "../src/lib/config.js";
import { validateSolResponse } from "../src/lib/validation.js";

function evidence(post_id, author_id, opportunity_score) {
  return {
    post_id,
    author_id,
    signal_type: "pain",
    evidence_excerpt: `Exact evidence ${post_id}`,
    opportunity_score,
  };
}

function cluster() {
  return {
    title: "AI review operations",
    target_customer: "accounting firms",
    problem: "manual AI output review",
    why_now: "AI adoption is ahead of controls",
    summary: "Several firms report the same review burden.",
    evidence_strength: 82,
    payment_signal: 61,
    evidence_post_ids: ["1", "2", "3", "4", "5", "6", "7"],
    evidence: [
      evidence("1", "author-a", 100),
      evidence("2", "author-a", 99),
      evidence("3", "author-a", 98),
      evidence("4", "author-a", 97),
      evidence("5", "author-b", 50),
      evidence("6", "author-c", 40),
      evidence("7", "author-d", 30),
    ],
  };
}

function idea(title, source_post_ids, rank) {
  return {
    rank,
    title,
    target_customer: "accounting firms",
    problem: "manual AI output review",
    offer: "fixed-fee AI review workflow setup",
    why_pay: "reduce review time and delivery errors",
    why_now: "AI use is already happening",
    initial_price: "$2,500",
    differentiation: "accounting-specific controls",
    speed_to_first_revenue: "one to three weeks",
    validation_plan: "Contact 20 owners and sell one pilot in seven days.",
    product_spec: {
      archetype: "specific_action_tool",
      core_action: "Checks uploaded AI-generated work against a saved rubric.",
      value_mechanisms: ["save_time", "save_money"],
      delivery_mode: "self_serve_web_app",
      sales_motion: "self_serve_checkout",
      business_model: "subscription",
      mvp_scope: "Upload, rubric checks, flagged output, and saved templates.",
      mvp_build_weeks: 4,
      recurring_trigger: "Every new client deliverable needs review.",
      latam_fit: "adaptable",
      latam_rationale: "The workflow can serve firms in LATAM without translation.",
    },
    hard_filter_checks: Object.fromEntries(
      IDEA_HARD_FILTER_CHECKS.map((name) => [name, true]),
    ),
    risks: ["firms may build internally"],
    assumptions: ["owners can see informal AI usage"],
    evidence_score: 80,
    source_post_ids,
  };
}

test("bounded Sol evidence keeps five strongest posts while preserving three authors", () => {
  const bounded = boundIdeaGenerationClusters([cluster()]);
  const boundedIds = bounded[0].evidence.map((item) => item.post_id);

  assert.deepEqual(boundedIds, ["1", "2", "3", "5", "6"]);
  assert.deepEqual(bounded[0].evidence_post_ids, boundedIds);
  assert.equal(new Set(bounded[0].evidence.map((item) => item.author_id)).size, 3);

  const messages = buildGenerateIdeasPrompt({ clusters: bounded });
  const payload = JSON.parse(messages[1].content.split("\n")[1]);
  assert.deepEqual(
    payload.clusters[0].evidence.map((item) => item.post_id),
    boundedIds,
  );
  assert.deepEqual(
    payload.clusters[0].evidence.map((item) => item.author_id),
    ["author-a", "author-a", "author-a", "author-b", "author-c"],
  );
});

test("Sol validation accepts exactly the bounded prompt IDs and rejects omitted IDs", () => {
  const bounded = boundIdeaGenerationClusters([cluster()]);
  const runPosts = cluster().evidence.map((item) => ({
    post_id: item.post_id,
    author_id: item.author_id,
  }));
  const validated = validateSolResponse(
    {
      assessment: { overall_evidence: "strong", notes: "Three authors agree." },
      ideas: [
        idea("Grounded", ["1", "5", "6"], 1),
        idea("Omitted source", ["1", "5", "7"], 2),
      ],
    },
    bounded,
    runPosts,
  );

  assert.deepEqual(validated.publishableIdeas.map((item) => item.title), [
    "Grounded",
  ]);
  assert.equal(validated.ideas.some((item) => item.title === "Omitted source"), false);
});

test("bounded evidence rejects clusters without three excerpt-bearing authors", () => {
  const weakCluster = cluster();
  weakCluster.evidence = weakCluster.evidence.filter(
    (item) => item.author_id === "author-a" || item.author_id === "author-b",
  );

  assert.throws(
    () => boundIdeaGenerationClusters([weakCluster]),
    /evidence excerpts from 3 authors/,
  );
});

test("Sol's contract makes self-serve web eligibility hard and archetypes soft", () => {
  for (const phrase of [
    "delivered through a website",
    "without booking a call",
    "consulting, an agency, an audit, a workshop, or custom implementation",
    "healthcare-, therapy-, or medical-adjacent",
    "enterprise product with a long sales process",
    "translation product",
    "generic chatbot, synthetic companion",
    "specific action and produces an outcome",
    "concrete recurring trigger",
  ]) {
    assert.match(GENERATE_IDEAS_INSTRUCTIONS, new RegExp(phrase));
  }

  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /soft archetypes, not quotas/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /LATAM is a preference, not evidence/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /weak companion idea/);
  assert.match(GENERATE_IDEAS_INSTRUCTIONS, /empty ideas array/);
  assert.match(
    GENERATE_IDEAS_INSTRUCTIONS,
    new RegExp(`${PIPELINE.minimumMvpBuildWeeks} to ${PIPELINE.maximumMvpBuildWeeks} weeks`),
  );
  assert.match(
    GENERATE_IDEAS_INSTRUCTIONS,
    new RegExp(`${PIPELINE.minimumIdeaEvidence}/100 evidence`),
  );
});

test("legacy service preferences are neutralized before Sol sees them", () => {
  const messages = buildGenerateIdeasPrompt({
    clusters: [cluster()],
    preferences: {
      offer_bias: "services_first",
      preferred_customers: ["local businesses"],
      preferred_business_models: [
        "consulting",
        "productized service",
        "small SaaS",
      ],
      avoid: ["gambling"],
      personal_advantages: ["growth marketing"],
    },
  });
  const payload = JSON.parse(messages[1].content.split("\n")[1]);
  const preferences = payload.preferences;

  assert.equal(preferences.offer_bias, DEFAULT_PREFERENCES.offer_bias);
  assert.ok(preferences.preferred_customers.includes("local businesses"));
  assert.ok(
    preferences.preferred_customers.includes(
      "LATAM entrepreneurs and small businesses",
    ),
  );
  assert.ok(preferences.preferred_business_models.includes("small SaaS"));
  assert.ok(preferences.preferred_business_models.includes("self-serve SaaS"));
  assert.ok(!preferences.preferred_business_models.includes("consulting"));
  assert.ok(
    !preferences.preferred_business_models.includes("productized service"),
  );
  assert.ok(preferences.avoid.includes("translation products"));
  assert.ok(preferences.avoid.includes("gambling"));
});
