import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  calculateOpportunityScore,
  createPostTextHash,
  discussionScore,
  engagementVelocity,
  hashPostText,
  hasObviousRepeatedPromotion,
  normalizePostText,
  percentileRanks,
  rankPosts,
  resultPositionScore,
  selectSignals,
  weightedEngagement,
} from "../src/lib/ranking.js";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function candidate({
  id,
  author = "author-a",
  likes = 0,
  position = 1,
  text = `Post ${id} describes a recurring manual AI workflow problem for a real business team.`,
  ...extra
}) {
  return {
    id,
    author_id: author,
    created_at: "2026-08-27T10:00:00.000Z",
    public_metrics: {
      like_count: likes,
      retweet_count: 0,
      reply_count: 0,
      quote_count: 0,
    },
    search_position: position,
    text,
    ...extra,
  };
}

test("normalizes and hashes post text exactly as the plan specifies", () => {
  const text = "  HELLO @User #AI https://example.com/path\nWorld  ";

  assert.equal(normalizePostText(text), "hello ai world");
  assert.equal(
    createPostTextHash(text),
    createHash("sha256").update("hello ai world").digest("hex"),
  );
  assert.equal(hashPostText(text), createPostTextHash(text));
  assert.equal(normalizePostText(null), "");
});

test("detects only explicit repeated promotional language", () => {
  assert.equal(
    hasObviousRepeatedPromotion("Buy now! Buy now! This offer ends tonight."),
    true,
  );
  assert.equal(
    hasObviousRepeatedPromotion(
      "This manual review is broken this manual review is broken for our team.",
    ),
    false,
  );
});

test("calculates engagement and discussion formulas", () => {
  const metrics = {
    like_count: 10,
    retweet_count: 2,
    reply_count: 3,
    quote_count: 4,
  };

  assert.equal(weightedEngagement(metrics), 31);
  assert.equal(discussionScore(metrics), Math.log1p(11));
  assert.equal(engagementVelocity(metrics, 1), Math.log1p(31) / 2 ** 0.35);
  assert.equal(engagementVelocity(metrics, 2), engagementVelocity(metrics, 1));
});

test("handles percentile ties, empty pools, and singleton pools", () => {
  assert.deepEqual(percentileRanks([]), []);
  assert.deepEqual(percentileRanks([42]), [1]);
  assert.deepEqual(percentileRanks([1, 2, 3]), [0, 0.5, 1]);
  assert.deepEqual(percentileRanks([2, 2, 2]), [0.5, 0.5, 0.5]);
  assert.deepEqual(percentileRanks([1, 2, 2, 3]), [0, 0.5, 0.5, 1]);
  assert.equal(resultPositionScore(1, 1), 1);
  assert.equal(resultPositionScore(20, 10), 0);
});

test("filters, deduplicates, ranks, and enforces three posts per author", () => {
  const duplicateText =
    "Accounting teams manually verify every AI summary before it reaches a client.";
  const posts = [
    candidate({ id: "duplicate-low", likes: 1, position: 1, text: duplicateText }),
    candidate({
      id: "duplicate-high",
      likes: 100,
      position: 2,
      text: `${duplicateText} https://example.com/details`,
    }),
    candidate({ id: "a-second", likes: 80, position: 3 }),
    candidate({ id: "a-third", likes: 70, position: 4 }),
    candidate({ id: "a-fourth", likes: 60, position: 5 }),
    candidate({ id: "other", author: "author-b", likes: 50, position: 6 }),
    candidate({ id: "short", text: "Too short" }),
    candidate({
      id: "repost",
      author: "author-c",
      text: "RT @someone This is a long repost that should never reach model ranking.",
    }),
    candidate({
      id: "promotion",
      author: "author-d",
      text: "Limited time sale! Limited time sale! Subscribe now for this amazing offer.",
    }),
  ];

  const ranked = rankPosts(posts, { now: NOW });
  const ids = ranked.map((post) => post.id);

  assert.equal(ids.includes("duplicate-low"), false);
  assert.equal(ids.includes("duplicate-high"), true);
  assert.equal(ids.includes("short"), false);
  assert.equal(ids.includes("repost"), false);
  assert.equal(ids.includes("promotion"), false);
  assert.equal(ranked.filter((post) => post.author_id === "author-a").length, 3);
  assert.equal(ids.includes("a-fourth"), false);
  assert.deepEqual(rankPosts(posts, { now: NOW }), ranked);

  for (const post of ranked) {
    assert.ok(post.deterministic_score >= 0 && post.deterministic_score <= 1);
    assert.match(post.normalized_text_hash, /^[a-f0-9]{64}$/);
  }
});

test("calculates and selects opportunity signals deterministically", () => {
  assert.ok(
    Math.abs(
      calculateOpportunityScore({
        deterministic_score: 0.8,
        commercial_score: 70,
        hype_score: 20,
      }) - 0.68,
    ) < Number.EPSILON,
  );

  const selected = selectSignals(
    [
      {
        post_id: "low-commercial",
        relevant: true,
        deterministic_score: 1,
        commercial_score: 49,
        hype_score: 0,
      },
      {
        post_id: "too-hyped",
        relevant: true,
        deterministic_score: 1,
        commercial_score: 100,
        hype_score: 76,
      },
      {
        post_id: "strong",
        relevant: true,
        deterministic_score: 0.8,
        commercial_score: 80,
        hype_score: 10,
      },
      {
        post_id: "weaker",
        relevant: true,
        deterministic_score: 0.3,
        commercial_score: 60,
        hype_score: 30,
      },
      {
        id: "camel-case",
        relevant: true,
        deterministicScore: 0.2,
        commercialScore: 55,
        hypeScore: 40,
      },
      {
        post_id: "irrelevant",
        relevant: false,
        deterministic_score: 1,
        commercial_score: 100,
        hype_score: 0,
      },
    ],
    { limit: 1 },
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].post_id, "strong");
  assert.equal(
    selected[0].opportunity_score,
    calculateOpportunityScore(selected[0]),
  );
});
