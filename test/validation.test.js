import assert from "node:assert/strict";
import test from "node:test";

import {
  validateExactExcerpt,
  validateLunaResponse,
  validateSolResponse,
  validateTerraResponse,
} from "../src/lib/validation.js";

function lunaItem(postId, overrides = {}) {
  return {
    post_id: postId,
    relevant: true,
    signal_type: "pain",
    target_customer: "accounting firms",
    problem: "manual review",
    evidence_excerpt: "manually review every AI summary",
    summary: "Teams need a reliable review workflow.",
    commercial_score: 80,
    hype_score: 10,
    ...overrides,
  };
}

function cluster(title, sourceIds, overrides = {}) {
  return {
    title,
    target_customer: "accounting firms",
    problem: "manual AI quality review",
    why_now: "AI adoption is increasing",
    summary: "Several teams report the same review burden.",
    evidence_post_ids: sourceIds,
    evidence_strength: 75,
    payment_signal: 50,
    ...overrides,
  };
}

function idea(title, sourceIds, overrides = {}) {
  return {
    rank: 1,
    title,
    target_customer: "accounting firms",
    problem: "manual AI quality review",
    offer: "fixed-fee workflow audit",
    why_pay: "reduce review time and errors",
    why_now: "informal AI use is already widespread",
    initial_price: "$2,500 setup",
    differentiation: "narrow accounting workflow focus",
    speed_to_first_revenue: "one to three weeks",
    validation_plan: "Contact 20 owners and sell one pilot in seven days.",
    risks: ["firms may use internal policies"],
    assumptions: ["owners can see informal AI use"],
    evidence_score: 80,
    source_post_ids: sourceIds,
    ...overrides,
  };
}

test("validates exact excerpts case-sensitively", () => {
  const text = "We manually review every AI summary before delivery.";

  assert.equal(validateExactExcerpt("manually review every AI summary", text), true);
  assert.equal(validateExactExcerpt("Manually review every AI summary", text), false);
  assert.equal(validateExactExcerpt("", text), false);
});

test("Luna validation returns one safe item for every supplied post", () => {
  const posts = [
    { id: "1", text: "We manually review every AI summary before delivery." },
    { id: "2", text: "A second team manually checks all generated client work." },
    { id: "3", text: "A third team has another operational AI review problem." },
  ];
  const response = {
    items: [
      lunaItem("1"),
      lunaItem("2", { evidence_excerpt: "manually checks" }),
      lunaItem("2", { evidence_excerpt: "generated client work" }),
      lunaItem("invented"),
    ],
  };

  const validated = validateLunaResponse(response, posts);

  assert.deepEqual(
    validated.items.map((item) => item.post_id),
    ["1", "2", "3"],
  );
  assert.equal(validated.items[0].relevant, true);
  assert.equal(validated.items[0].evidence_excerpt, "manually review every AI summary");
  assert.equal(validated.items[1].relevant, false);
  assert.equal(validated.items[2].relevant, false);
});

test("Luna replaces a non-exact excerpt and invalid scores make an item irrelevant", () => {
  const posts = [
    { id: "1", text: "We manually review every AI summary before delivery." },
    { id: "2", text: "Another long operational complaint appears here." },
  ];
  const validated = validateLunaResponse(
    {
      items: [
        lunaItem("1", { evidence_excerpt: "Manually review every AI summary" }),
        lunaItem("2", { commercial_score: 101 }),
      ],
    },
    posts,
  );

  assert.equal(validated.items[0].relevant, true);
  assert.equal(validated.items[0].evidence_excerpt, "");
  assert.deepEqual(validated.items[1], {
    post_id: "2",
    relevant: false,
    signal_type: "none",
    target_customer: "",
    problem: "",
    evidence_excerpt: "",
    summary: "",
    commercial_score: 0,
    hype_score: 0,
  });
  assert.throws(() => validateLunaResponse({}, posts), /items array/);
});

test("Terra separates source-valid clusters from eligible clusters", () => {
  const signals = [
    { post_id: "1", author_id: "a", relevant: true, signal_type: "pain" },
    { post_id: "2", author_id: "b", relevant: true, signal_type: "request" },
    {
      post_id: "3",
      author_id: "c",
      relevant: true,
      signal_type: "new_capability",
    },
    { post_id: "4", author_id: "a", relevant: true, signal_type: "pain" },
    { post_id: "5", author_id: "d", relevant: true, signal_type: "hype" },
    { post_id: "6", author_id: "e", relevant: true, signal_type: "hype" },
  ];
  const response = {
    clusters: [
      cluster("Eligible", ["1", "2", "3"], { evidence_strength: 80 }),
      cluster("Weak", ["1", "2", "3"], { evidence_strength: 59 }),
      cluster("Commentary", ["1", "5", "6"]),
      cluster("Deduplicated sources", ["1", "1", "2", "3"], {
        evidence_strength: 70,
      }),
      cluster("Invented source", ["1", "2", "999"]),
    ],
  };

  const validated = validateTerraResponse(response, signals, {
    runPostIds: signals.map((signal) => signal.post_id),
    maxClusters: 1,
  });

  assert.equal(validated.clusters.length, 4);
  assert.deepEqual(
    validated.clusters.find((item) => item.title === "Deduplicated sources")
      .evidence_post_ids,
    ["1", "2", "3"],
  );
  assert.deepEqual(
    validated.clusters.find((item) => item.title === "Weak").eligibility_reasons,
    ["weak_evidence"],
  );
  assert.ok(
    validated.clusters
      .find((item) => item.title === "Commentary")
      .eligibility_reasons.includes("primarily_commentary"),
  );
  assert.equal(validated.eligibleClusters.length, 1);
  assert.equal(validated.eligibleClusters[0].title, "Eligible");
  assert.deepEqual(
    validated.clusters.find((item) => item.title === "Deduplicated sources")
      .eligibility_reasons,
    ["cluster_limit"],
  );
});

test("Sol discards invented IDs and separates valid from publishable ideas", () => {
  const clusters = [cluster("Supplied", ["1", "2", "3", "4"])];
  const runPosts = [
    { post_id: "1", author_id: "a" },
    { post_id: "2", author_id: "b" },
    { post_id: "3", author_id: "c" },
    { post_id: "4", author_id: "a" },
    { post_id: "9", author_id: "z" },
  ];
  const response = {
    assessment: { overall_evidence: "strong", notes: "Three authors agree." },
    ideas: [
      idea("Publishable", ["1", "2", "3"], { rank: 1 }),
      idea("Insufficient", ["1", "4"], { rank: 2 }),
      idea("Invented", ["1", "2", "9"], { rank: 3 }),
      idea("Missing required field", ["1", "2", "3"], {
        rank: 4,
        title: " ",
      }),
    ],
  };

  const validated = validateSolResponse(response, clusters, runPosts);

  assert.deepEqual(
    validated.ideas.map((item) => item.title),
    ["Publishable", "Insufficient"],
  );
  assert.deepEqual(validated.publishableIdeas.map((item) => item.title), [
    "Publishable",
  ]);
  assert.deepEqual(validated.ideas[1].validation_errors, [
    "insufficient_posts",
    "insufficient_authors",
  ]);
});

test("Sol caps publishable ideas by rank and requires a valid assessment", () => {
  const clusters = [cluster("Supplied", ["1", "2", "3"])];
  const runPosts = [
    { post_id: "1", author_id: "a" },
    { post_id: "2", author_id: "b" },
    { post_id: "3", author_id: "c" },
  ];
  const response = {
    assessment: { overall_evidence: "strong", notes: "Enough evidence." },
    ideas: [
      idea("Third", ["1", "2", "3"], { rank: 3 }),
      idea("First", ["1", "2", "3"], { rank: 1 }),
      idea("Second", ["1", "2", "3"], { rank: 2 }),
    ],
  };

  const validated = validateSolResponse(response, clusters, runPosts, {
    maxPublishedIdeas: 2,
  });

  assert.deepEqual(validated.publishableIdeas.map((item) => item.title), [
    "First",
    "Second",
  ]);
  assert.throws(
    () => validateSolResponse({ ideas: [] }, clusters, runPosts),
    /valid assessment/,
  );
});
