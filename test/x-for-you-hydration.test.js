import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20default%20undefined",
      };
    }

    return nextResolve(specifier, context);
  },
});

const {
  hydrateAndMergeForYouPosts,
  normalizeForYouCandidates,
} = await import("../src/lib/x/for-you-hydration.js");

function makePost(id, overrides = {}) {
  return {
    id,
    text: `Post ${id} describes a concrete AI workflow problem for a real team.`,
    author_id: `8${id}`,
    author_username: `author_${id}`,
    created_at: "2026-08-28T12:00:00.000Z",
    conversation_id: id,
    referenced_tweets: [],
    public_metrics: {
      impression_count: 25_000,
      reply_count: 3,
      like_count: 20,
      bookmark_count: 5,
    },
    url: `https://x.com/author_${id}/status/${id}`,
    ...overrides,
  };
}

function makeSearchResult() {
  const followed = {
    ...makePost("101"),
    source_channel: "followed",
    search_position: 7,
  };

  return {
    posts: [followed],
    rankablePosts: [followed],
    partial: false,
    partialError: null,
    meta: {
      resultCount: 1,
      rawResultCount: 2,
      qualityPassed: 1,
      crossChannelDuplicates: 1,
      metricsCapturedAt: "2026-08-29T00:00:00.000Z",
    },
  };
}

test("For You workflow candidates are exact, bounded, unique, and feed ordered", () => {
  assert.deepEqual(
    normalizeForYouCandidates([
      { post_id: "202", feed_position: 9 },
      { post_id: "201", feed_position: 2 },
    ]),
    [
      { post_id: "201", feed_position: 2 },
      { post_id: "202", feed_position: 9 },
    ],
  );
  assert.deepEqual(normalizeForYouCandidates(undefined), []);

  assert.throws(
    () => normalizeForYouCandidates([
      { post_id: "201", feed_position: 1, text: "browser data" },
    ]),
    /candidate 1 is invalid/i,
  );
  assert.throws(
    () => normalizeForYouCandidates([
      { post_id: "201", feed_position: 1 },
      { post_id: "201", feed_position: 2 },
    ]),
    /post IDs must be unique/i,
  );
  assert.throws(
    () => normalizeForYouCandidates([
      { post_id: "201", feed_position: 1 },
      { post_id: "202", feed_position: 1 },
    ]),
    /feed positions must be unique/i,
  );
  assert.throws(
    () => normalizeForYouCandidates(
      Array.from({ length: 101 }, (_, index) => ({
        post_id: String(1_000 + index),
        feed_position: Math.min(index + 1, 100),
      })),
    ),
    /cannot exceed 100 posts/i,
  );
});

test("API-only runs preserve the original result and never invoke lookup", async () => {
  const searchResult = makeSearchResult();
  let lookupCalled = false;
  const result = await hydrateAndMergeForYouPosts({
    searchResult,
    candidates: [],
    windowStart: "not consulted",
    windowEnd: "not consulted",
    lookup: async () => {
      lookupCalled = true;
      throw new Error("must not run");
    },
  });

  assert.equal(result, searchResult);
  assert.equal(lookupCalled, false);
});

test("For You hydrations preserve feed positions and enter only the existing eligible rank pool", async () => {
  const searchResult = makeSearchResult();
  const candidates = [
    { post_id: "207", feed_position: 7 },
    { post_id: "101", feed_position: 1 },
    { post_id: "204", feed_position: 4 },
    { post_id: "202", feed_position: 2 },
    { post_id: "206", feed_position: 6 },
    { post_id: "203", feed_position: 3 },
    { post_id: "205", feed_position: 5 },
    { post_id: "208", feed_position: 8 },
    { post_id: "209", feed_position: 9 },
  ];
  let requestedIds;

  const result = await hydrateAndMergeForYouPosts({
    searchResult,
    candidates,
    windowStart: "2026-08-26T00:00:00.000Z",
    windowEnd: "2026-08-29T00:00:00.000Z",
    lookup: async ({ ids }) => {
      requestedIds = ids;
      return {
        posts: [
          makePost("101"),
          makePost("202"),
          makePost("203", { created_at: "2026-08-25T23:59:59.999Z" }),
          makePost("204", {
            referenced_tweets: [{ type: "retweeted", id: "9004" }],
          }),
          makePost("205", {
            referenced_tweets: [{ type: "quoted", id: "9005" }],
          }),
          makePost("206", {
            public_metrics: {
              impression_count: 18_999,
              reply_count: 100,
              like_count: 100,
              bookmark_count: 100,
            },
          }),
          makePost("207"),
          makePost("208", { created_at: "2026-08-29T00:00:00.000Z" }),
        ],
        unavailableIds: ["209"],
        unknownIds: [],
      };
    },
  });

  assert.deepEqual(requestedIds, [
    "101",
    "202",
    "203",
    "204",
    "205",
    "206",
    "207",
    "208",
    "209",
  ]);
  assert.deepEqual(
    result.posts.map((post) => [
      post.id,
      post.source_channel,
      post.search_position,
    ]),
    [
      ["101", "followed", 7],
      ["202", "for_you", 2],
      ["204", "for_you", 4],
      ["205", "for_you", 5],
      ["206", "for_you", 6],
      ["207", "for_you", 7],
    ],
  );
  assert.deepEqual(
    result.rankablePosts.map((post) => post.id),
    ["101", "202", "207"],
  );
  assert.equal(result.meta.resultCount, 6);
  assert.equal(result.meta.rawResultCount, 10);
  assert.equal(result.meta.qualityPassed, 3);
  assert.equal(result.meta.crossChannelDuplicates, 2);
  assert.equal(result.meta.forYouRequested, 9);
  assert.equal(result.meta.forYouHydrated, 8);
  assert.equal(result.meta.forYouReturned, 5);
  assert.equal(result.meta.forYouUnavailable, 1);
  assert.equal(result.meta.forYouUnknown, 0);
  assert.equal(result.meta.forYouOutsideWindow, 2);
  assert.equal(result.meta.forYouCrossChannelDuplicates, 1);
  assert.equal(result.meta.forYouRepostsRejected, 1);
  assert.equal(result.meta.forYouQuotesRejected, 1);
  assert.equal(result.meta.forYouViewQualityRejected, 1);
  assert.equal(result.meta.forYouQualityPassed, 2);
});

test("the additive migration and posts UI recognize the For You channel", async () => {
  const [migration, postsPage, workflow] = await Promise.all([
    readFile(
      new URL(
        "../supabase/migrations/005_for_you_source_channel.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../src/app/posts/page.js", import.meta.url), "utf8"),
    readFile(
      new URL("../src/workflows/daily-research-steps.js", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(
    migration,
    /source_channel in \('followed', 'topic', 'for_you'\)/i,
  );
  assert.match(postsPage, /<option value="for_you">For You discovery<\/option>/);
  assert.match(postsPage, /counts\.sent_to_luna_for_you/);
  assert.match(workflow, /forYouCandidates = \[\]/);
  assert.match(workflow, /hydrateAndMergeForYouPosts\(/);
  const officialSearch = workflow.indexOf("await searchHybridRecentPosts");
  const officialSearchCatch = workflow.indexOf("} catch (error)", officialSearch);
  const optionalHydration = workflow.indexOf(
    "await hydrateAndMergeForYouPosts",
    officialSearchCatch,
  );
  const optionalHydrationCatch = workflow.indexOf(
    "} catch {",
    optionalHydration,
  );
  assert.ok(
    officialSearch >= 0 &&
      officialSearch < officialSearchCatch &&
      officialSearchCatch < optionalHydration &&
      optionalHydration < optionalHydrationCatch,
  );
  assert.doesNotMatch(
    workflow,
    /settings_snapshot\.for_you_candidates/,
  );
});
