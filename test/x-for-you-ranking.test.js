import assert from "node:assert/strict";
import { test } from "node:test";

import { POST_QUALITY } from "../src/lib/config.js";
import { rankPosts } from "../src/lib/ranking.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function candidate({
  id,
  author,
  sourceChannel,
  text = `A concrete recurring workflow problem for team ${author} needs a reliable product.`,
  views = POST_QUALITY.minimumViews,
}) {
  return {
    id,
    author_id: author,
    text,
    created_at: "2026-08-29T12:00:00.000Z",
    source_channel: sourceChannel,
    public_metrics: {
      impression_count: views,
      reply_count: 10,
      like_count: 20,
      bookmark_count: 5,
    },
  };
}

test("followed priority wins cross-channel deduplication before For You scoring", () => {
  const duplicateText =
    "A recurring manual AI workflow problem costs this operations team hours every week.";
  const ranked = rankPosts(
    [
      candidate({
        id: "followed-duplicate",
        author: "followed-author",
        sourceChannel: "followed",
        text: duplicateText,
      }),
      candidate({
        id: "for-you-duplicate",
        author: "for-you-author",
        sourceChannel: "for_you",
        text: duplicateText,
        views: POST_QUALITY.minimumViews * 20,
      }),
    ],
    {
      now: NOW,
      limit: 2,
      prioritySourceChannel: "followed",
    },
  );

  assert.deepEqual(ranked.map((post) => post.id), ["followed-duplicate"]);
});

test("an author-capped followed candidate does not reserve its text hash", () => {
  const fallbackText =
    "Teams keep rebuilding this manual AI approval workflow and need one reliable tool.";
  const posts = [
    ...Array.from({ length: 3 }, (_, index) => candidate({
      id: `followed-${index + 1}`,
      author: "capped-author",
      sourceChannel: "followed",
      text: `Distinct recurring workflow problem number ${index + 1} costs the same operations team hours every week.`,
      views: POST_QUALITY.minimumViews * (5 - index),
    })),
    candidate({ id: "followed-capped", author: "capped-author", sourceChannel: "followed", text: fallbackText }),
    candidate({ id: "for-you-fallback", author: "fallback-author", sourceChannel: "for_you", text: fallbackText }),
  ];
  const ranked = rankPosts(posts, {
    now: NOW,
    limit: posts.length,
    prioritySourceChannel: "followed",
  });
  const ids = ranked.map((post) => post.id);

  assert.equal(ids.includes("followed-capped"), false);
  assert.equal(ids.includes("for-you-fallback"), true);
});
