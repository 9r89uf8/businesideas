import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  calculateOpportunityScore,
  clampPostAge,
  createPostTextHash,
  hashPostText,
  hasObviousRepeatedPromotion,
  metricSignal,
  normalizePostText,
  passesPostQualityGate,
  percentileRanks,
  postAgeInHours,
  qualityMetrics,
  qualityPercentileRanks,
  qualitySignals,
  rankPosts,
  selectHybridAiInput,
  selectSignals,
} from "../src/lib/ranking.js";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function candidate({
  id,
  author = "author-a",
  views = 50_000,
  comments = 0,
  likes = 0,
  saves = 0,
  reposts = 0,
  quotes = 0,
  position = 1,
  text = `Post ${id} describes a recurring manual AI workflow problem for a real business team.`,
  ...extra
}) {
  return {
    id,
    author_id: author,
    created_at: "2026-08-27T10:00:00.000Z",
    public_metrics: {
      impression_count: views,
      reply_count: comments,
      like_count: likes,
      bookmark_count: saves,
      retweet_count: reposts,
      quote_count: quotes,
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

test("calculates view-first signals and preserves the requested metric order", () => {
  const metrics = {
    impression_count: 10_000,
    reply_count: 30,
    like_count: 10,
    bookmark_count: 4,
    retweet_count: 1_000_000,
    quote_count: 1_000_000,
  };

  assert.deepEqual(qualityMetrics(metrics), {
    views: 10_000,
    comments: 30,
    likes: 10,
    saves: 4,
  });
  assert.equal(metricSignal(10_000, 1), Math.log1p(10_000 / 2 ** 0.55));
  assert.equal(metricSignal(10_000, 2), metricSignal(10_000, 1));
  assert.deepEqual(
    qualitySignals(metrics, 2),
    qualitySignals({
      impression_count: 10_000,
      reply_count: 30,
      like_count: 10,
      bookmark_count: 4,
      retweet_count: 0,
      quote_count: 0,
    }, 2),
  );
});

test("clamps post age conservatively", () => {
  assert.equal(clampPostAge(1), 2);
  assert.equal(clampPostAge(500), 168);
  assert.equal(clampPostAge(Number.NaN), 168);
  assert.equal(
    postAgeInHours({ created_at: "2026-08-27T10:00:00Z" }, NOW),
    2,
  );
  assert.equal(postAgeInHours({ created_at: "not-a-date" }, NOW), 168);
  assert.ok(metricSignal(1_000, 2) > metricSignal(1_000, 24));
});

test("handles percentile ties, empty pools, and singleton pools", () => {
  assert.deepEqual(percentileRanks([]), []);
  assert.deepEqual(percentileRanks([42]), [1]);
  assert.deepEqual(percentileRanks([1, 2, 3]), [0, 0.5, 1]);
  assert.deepEqual(percentileRanks([2, 2, 2]), [0.5, 0.5, 0.5]);
  assert.deepEqual(percentileRanks([1, 2, 2, 3]), [0, 0.5, 0.5, 1]);
  assert.deepEqual(qualityPercentileRanks([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(qualityPercentileRanks([0, 0, 5]), [0, 0, 1]);
  assert.deepEqual(qualityPercentileRanks([5]), [1]);
});

test("views dominate comments, which outrank likes and saves", () => {
  const reachWinner = rankPosts([
    candidate({ id: "views", author: "views-author", views: 100_000 }),
    candidate({
      id: "interactions",
      author: "interaction-author",
      views: 50_000,
      comments: 10_000,
      likes: 10_000,
      saves: 10_000,
    }),
  ], { now: NOW });

  assert.equal(reachWinner[0].id, "views");
  assert.ok(reachWinner[0].deterministic_score > reachWinner[1].deterministic_score);

  const secondaryOrder = rankPosts([
    candidate({ id: "comments", author: "comment-author", views: 50_000, comments: 1 }),
    candidate({ id: "likes", author: "like-author", views: 50_000, likes: 1 }),
    candidate({ id: "saves", author: "save-author", views: 50_000, saves: 1 }),
  ], { now: NOW });

  assert.deepEqual(
    secondaryOrder.map((post) => post.id),
    ["comments", "likes", "saves"],
  );
});

test("requires at least 50,000 raw views before any engagement ranking", () => {
  const justBelow = candidate({
    id: "just-below",
    author: "below-author",
    views: 49_999,
    comments: 1_000_000,
    likes: 1_000_000,
    saves: 1_000_000,
  });
  const boundary = candidate({
    id: "boundary",
    author: "boundary-author",
    views: 50_000,
  });
  const missing = candidate({ id: "missing", author: "missing-author" });
  delete missing.public_metrics.impression_count;

  assert.equal(passesPostQualityGate(justBelow), false);
  assert.equal(passesPostQualityGate(boundary), true);
  assert.equal(passesPostQualityGate(missing), false);
  assert.deepEqual(
    rankPosts([justBelow, boundary, missing], { now: NOW }).map(
      (post) => post.id,
    ),
    ["boundary"],
  );
});

test("repost, quote, and X result position never affect quality", () => {
  const ranked = rankPosts([
    candidate({
      id: "b-poison",
      author: "poison-author",
      views: 50_000,
      comments: 5,
      likes: 20,
      saves: 2,
      reposts: 1_000_000_000,
      quotes: 1_000_000_000,
      position: 1,
    }),
    candidate({
      id: "a-clean",
      author: "clean-author",
      views: 50_000,
      comments: 5,
      likes: 20,
      saves: 2,
      position: 200,
    }),
  ], { now: NOW });

  assert.equal(ranked[0].id, "a-clean");
  assert.equal(ranked[0].deterministic_score, ranked[1].deterministic_score);
  assert.equal(ranked[0].view_signal, ranked[1].view_signal);
});

test("posts without views are excluded instead of receiving quality credit", () => {
  const ranked = rankPosts([
    candidate({ id: "zero-a", author: "zero-author-a", views: 0 }),
    candidate({ id: "zero-b", author: "zero-author-b", views: 0 }),
  ], { now: NOW });

  assert.deepEqual(ranked, []);
});

test("filters, deduplicates, ranks, and enforces three posts per author", () => {
  const duplicateText =
    "Accounting teams manually verify every AI summary before it reaches a client.";
  const posts = [
    candidate({ id: "duplicate-low", views: 50_000, position: 1, text: duplicateText }),
    candidate({
      id: "duplicate-high",
      views: 100_000,
      position: 2,
      text: `${duplicateText} https://example.com/details`,
    }),
    candidate({ id: "a-second", views: 90_000, position: 3 }),
    candidate({ id: "a-third", views: 80_000, position: 4 }),
    candidate({ id: "a-fourth", views: 70_000, position: 5 }),
    candidate({ id: "other", author: "author-b", views: 60_000, position: 6 }),
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

test("hybrid AI selection caps followed posts at half without forcing a quota", () => {
  const ranked = [
    { id: "followed-1", source_channel: "followed" },
    { id: "topic-1", source_channel: "topic" },
    { id: "followed-2", source_channel: "followed" },
    { id: "followed-3", source_channel: "followed" },
    { id: "topic-2", source_channel: "topic" },
    { id: "followed-4", source_channel: "followed" },
    { id: "topic-3", source_channel: "topic" },
    { id: "topic-4", source_channel: "topic" },
  ];

  const selected = selectHybridAiInput(ranked, { limit: 6 });
  assert.deepEqual(
    selected.map((post) => post.id),
    [
      "followed-1",
      "topic-1",
      "followed-2",
      "followed-3",
      "topic-2",
      "topic-3",
    ],
  );
  assert.equal(
    selected.filter((post) => post.source_channel === "followed").length,
    3,
  );

  const withoutForcedQuota = selectHybridAiInput(
    ranked.filter((post) => post.id !== "followed-2" && post.id !== "followed-3" && post.id !== "followed-4"),
    { limit: 6 },
  );
  assert.equal(
    withoutForcedQuota.filter((post) => post.source_channel === "followed")
      .length,
    1,
  );
  assert.equal(withoutForcedQuota.length, 5);
  assert.throws(() => selectHybridAiInput(null, { limit: 5 }), /array/);
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
