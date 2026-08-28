import assert from "node:assert/strict";
import test from "node:test";

import {
  boundIdeaGenerationClusters,
  buildGenerateIdeasPrompt,
} from "../src/lib/prompts/generate-ideas.js";
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
