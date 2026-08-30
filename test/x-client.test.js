import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { registerHooks } from "node:module";

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
  XApiError,
  X_EXPANSIONS,
  X_POST_FIELDS,
  X_USER_FIELDS,
  normalizeXPost,
  xRequest,
} = await import("../src/lib/x/client.js");
const {
  buildFollowedAccountsQuery,
  getRecentSearchWindow,
  isEligiblePost,
  isStrongFollowedPost,
  normalizeFollowedUsernames,
  searchHybridRecentPosts,
  searchRecentPosts,
} = await import("../src/lib/x/search-posts.js");
const { lookupPosts } = await import("../src/lib/x/lookup-posts.js");

const TEST_TOKEN = "test-bearer-token-that-must-never-leak";
const previousToken = process.env.X_BEARER_TOKEN;

before(() => {
  process.env.X_BEARER_TOKEN = TEST_TOKEN;
});

after(() => {
  if (previousToken === undefined) {
    delete process.env.X_BEARER_TOKEN;
  } else {
    process.env.X_BEARER_TOKEN = previousToken;
  }
});

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function makePost(index) {
  const id = String(1_000 + index);
  const authorId = String(10_000 + index);

  return {
    id,
    text: `Post ${id} describes a concrete AI workflow problem.`,
    author_id: authorId,
    created_at: "2026-08-26T12:00:00.000Z",
    conversation_id: id,
    lang: "en",
    public_metrics: {
      impression_count: 50_000 + index * 1_000,
      reply_count: 3,
      like_count: index,
      bookmark_count: 4,
      retweet_count: 2,
      quote_count: 4,
    },
  };
}

function makeUser(index) {
  return {
    id: String(10_000 + index),
    username: `author_${index}`,
  };
}

test("xRequest keeps credentials out of a rate-limit error", async () => {
  const resetEpoch = Math.floor(Date.now() / 1_000) + 60;
  let requestOptions;

  await assert.rejects(
    xRequest("/2/tweets", {
      searchParams: { ids: "123" },
      fetchImpl: async (_url, options) => {
        requestOptions = options;
        return jsonResponse(
          {
            title: "Too Many Requests",
            detail: `Authorization: Bearer ${TEST_TOKEN}`,
          },
          {
            status: 429,
            headers: {
              "retry-after": "10",
              "x-rate-limit-reset": String(resetEpoch),
            },
          },
        );
      },
    }),
    (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.status, 429);
      assert.equal(error.isRateLimited, true);
      assert.equal(error.rateLimitResetEpochSeconds, resetEpoch);
      assert.equal(
        error.rateLimitResetAt,
        new Date(resetEpoch * 1_000).toISOString(),
      );
      assert.ok(error.retryAfterMs >= 10_000);
      assert.doesNotMatch(String(error), new RegExp(TEST_TOKEN));
      assert.doesNotMatch(JSON.stringify(error), new RegExp(TEST_TOKEN));
      return true;
    },
  );

  assert.equal(requestOptions.cache, "no-store");
  assert.equal(requestOptions.headers.Authorization, `Bearer ${TEST_TOKEN}`);
});

test("getRecentSearchWindow uses a rolling 72 hours and caps X's boundary", () => {
  assert.deepEqual(
    getRecentSearchWindow({
      endTime: "2026-08-27T13:00:00Z",
      currentTime: "2026-08-28T13:00:00Z",
    }),
    {
      startTime: "2026-08-24T13:00:00Z",
      endTime: "2026-08-27T13:00:00Z",
    },
  );

  assert.deepEqual(
    getRecentSearchWindow({
      startTime: "2026-08-01T13:00:00Z",
      endTime: "2026-08-27T13:00:00Z",
      currentTime: "2026-08-28T13:00:00Z",
    }),
    {
      startTime: "2026-08-20T13:00:00Z",
      endTime: "2026-08-27T13:00:00Z",
    },
  );
});

test("getRecentSearchWindow keeps end_time 30 seconds behind X", () => {
  assert.deepEqual(
    getRecentSearchWindow({
      endTime: "2026-08-27T13:00:00Z",
      currentTime: "2026-08-27T13:00:00Z",
    }),
    {
      startTime: "2026-08-24T12:59:30Z",
      endTime: "2026-08-27T12:59:30Z",
    },
  );
});

test("X normalization preserves views and saves without inventing missing counts", () => {
  const normalized = normalizeXPost({
    id: "123",
    author_id: "456",
    created_at: "2026-08-27T12:00:00Z",
    public_metrics: {
      impression_count: 12_345,
      reply_count: 8,
      like_count: 120,
      bookmark_count: 14,
      retweet_count: 999,
      quote_count: 999,
    },
    referenced_tweets: [
      { type: "quoted", id: "111" },
      { type: "replied_to", id: "222" },
      { type: "unsupported", id: "333" },
    ],
  });

  assert.deepEqual(normalized.public_metrics, {
    impression_count: 12_345,
    reply_count: 8,
    like_count: 120,
    bookmark_count: 14,
  });
  assert.deepEqual(normalized.referenced_tweets, [
    { type: "quoted", id: "111" },
    { type: "replied_to", id: "222" },
  ]);
  assert.ok(X_POST_FIELDS.includes("referenced_tweets"));

  const missing = normalizeXPost({
    id: "789",
    author_id: "987",
    public_metrics: { reply_count: 0, like_count: 0 },
  });
  assert.equal(missing.public_metrics.impression_count, null);
  assert.equal(missing.public_metrics.bookmark_count, null);
});

test("followed usernames are safely normalized, deduplicated, and capped", () => {
  const normalized = normalizeFollowedUsernames([
    " @OpenAI ",
    "openai",
    "valid_user",
    "bad-name OR AI",
    null,
    ...Array.from({ length: 20 }, (_, index) => `account_${index}`),
  ]);

  assert.equal(normalized[0], "openai");
  assert.equal(normalized[1], "valid_user");
  assert.equal(normalized.length, 12);
  assert.equal(normalized.includes("bad-name or ai"), false);

  const query = buildFollowedAccountsQuery(normalized);
  const maximumLengthQuery = buildFollowedAccountsQuery(
    Array.from(
      { length: 12 },
      (_, index) => `${String(index).padStart(2, "0")}${"a".repeat(13)}`,
    ),
  );
  assert.ok(query.length <= 512);
  assert.ok(maximumLengthQuery.length <= 512);
  assert.match(query, /^\(AI OR/);
  assert.match(query, /\(from:openai OR from:valid_user/);
  assert.match(query, /-is:retweet -is:quote$/);
  assert.equal(buildFollowedAccountsQuery(["invalid handle!"]), null);
});

test("every source uses the inclusive 50K view floor", () => {
  const now = "2026-08-27T13:00:00Z";
  const postWith = (publicMetrics) => ({
    created_at: "2026-08-27T11:00:00Z",
    public_metrics: publicMetrics,
  });

  assert.equal(
    isStrongFollowedPost(
      postWith({
        impression_count: 49_999,
        reply_count: 1_000_000,
        like_count: 1_000_000,
        bookmark_count: 1_000_000,
        retweet_count: 1_000_000,
        quote_count: 1_000_000,
      }),
      { now },
    ),
    false,
  );
  assert.equal(
    isStrongFollowedPost(
      postWith({
        impression_count: 50_000,
        reply_count: 0,
        like_count: 0,
        bookmark_count: 0,
      }),
      { now },
    ),
    true,
  );
  assert.equal(
    isEligiblePost(
      postWith({
        reply_count: 100,
        like_count: 1_000,
        bookmark_count: 1_000,
      }),
      { now },
    ),
    false,
  );
  assert.equal(
    isStrongFollowedPost(postWith({ impression_count: 50_000 }), { now }),
    true,
  );
});

test("hybrid search queries followed accounts first and keeps retained candidates bounded", async () => {
  const calls = [];
  const followedIndexes = [1, 2, 3, 4, 5];
  const topicIndexes = [5, 6, 7, 8, 9];

  const result = await searchHybridRecentPosts({
    query: "AI problem lang:en -is:retweet",
    followedUsernames: ["OpenAI", "AnthropicAI"],
    startTime: "2026-08-26T13:00:00Z",
    endTime: "2026-08-27T13:00:00Z",
    qualityTime: "2026-08-27T13:00:00Z",
    candidateLimit: 10,
    aiInputLimit: 10,
    fetchImpl: async (requestUrl) => {
      const url = new URL(requestUrl);
      const query = url.searchParams.get("query");
      calls.push({
        query,
        maxResults: url.searchParams.get("max_results"),
        startTime: url.searchParams.get("start_time"),
        endTime: url.searchParams.get("end_time"),
      });
      const followed = query.includes("from:openai");
      const indexes = followed ? followedIndexes : topicIndexes;
      const posts = indexes.map(makePost);

      if (followed) {
        posts[0] = {
          ...posts[0],
          public_metrics: {
            impression_count: 49_999,
            reply_count: 0,
            like_count: 1,
            bookmark_count: 0,
            retweet_count: 0,
            quote_count: 0,
          },
        };
      }

      return jsonResponse({
        data: posts,
        includes: { users: indexes.map(makeUser) },
        meta: { result_count: indexes.length },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /from:openai/);
  assert.equal(calls[1].query, "AI problem lang:en -is:retweet");
  assert.equal(calls[0].startTime, calls[1].startTime);
  assert.equal(calls[0].endTime, calls[1].endTime);
  assert.equal(result.meta.rawResultCount, 10);
  assert.ok(result.meta.rawResultCount <= 10);
  assert.equal(result.meta.followedReturned, 5);
  assert.equal(result.meta.followedQualityPassed, 4);
  assert.equal(result.meta.topicRequestedLimit, 6);
  assert.equal(result.meta.topicReturned, 4);
  assert.equal(result.meta.topicQualityPassed, 4);
  assert.equal(result.meta.qualityPassed, 8);
  assert.equal(result.meta.crossChannelDuplicates, 1);
  assert.equal(result.meta.metricsCapturedAt, "2026-08-27T13:00:00.000Z");
  assert.equal(result.posts.length, 9);
  assert.equal(result.rankablePosts.length, 8);
  assert.equal(result.posts[0].source_channel, "followed");
  assert.equal(
    result.rankablePosts.some((post) => post.id === "1001"),
    false,
  );
});

test("low-quality followed results never reduce the topic fallback budget", async () => {
  const calls = [];
  const followedIndexes = Array.from({ length: 10 }, (_, index) => index + 1);
  const topicIndexes = Array.from({ length: 20 }, (_, index) => index + 101);

  const result = await searchHybridRecentPosts({
    query: "AI problem lang:en -is:retweet",
    followedUsernames: ["quiet_active"],
    startTime: "2026-08-26T13:00:00Z",
    endTime: "2026-08-27T13:00:00Z",
    qualityTime: "2026-08-27T13:00:00Z",
    candidateLimit: 20,
    aiInputLimit: 20,
    fetchImpl: async (requestUrl) => {
      const url = new URL(requestUrl);
      const followed = url.searchParams.get("query").includes(
        "from:quiet_active",
      );
      calls.push(url.searchParams.get("max_results"));
      const indexes = followed ? followedIndexes : topicIndexes;
      const posts = indexes.map(makePost);

      if (followed) {
        for (const post of posts) {
          post.public_metrics = {
            impression_count: 49_999,
            reply_count: 0,
            like_count: 0,
            bookmark_count: 0,
          };
        }
      }

      return jsonResponse({
        data: posts,
        includes: { users: indexes.map(makeUser) },
        meta: { result_count: indexes.length },
      });
    },
  });

  assert.deepEqual(calls, ["10", "20"]);
  assert.equal(result.meta.followedReturned, 10);
  assert.equal(result.meta.followedQualityPassed, 0);
  assert.equal(result.meta.topicRequestedLimit, 20);
  assert.equal(result.meta.topicReturned, 20);
  assert.equal(result.meta.topicQualityPassed, 20);
  assert.equal(result.meta.qualityPassed, 20);
  assert.equal(result.meta.rawResultCount, 30);
  assert.equal(result.posts.length, 20);
  assert.equal(result.rankablePosts.length, 20);
  assert.ok(result.posts.every((post) => post.source_channel === "topic"));
});

test("hybrid search keeps sub-50K topic posts inspectable but not rankable", async () => {
  const result = await searchHybridRecentPosts({
    query: "AI problem lang:en -is:retweet",
    startTime: "2026-08-24T13:00:00Z",
    endTime: "2026-08-27T13:00:00Z",
    qualityTime: "2026-08-27T13:00:00Z",
    candidateLimit: 10,
    aiInputLimit: 10,
    fetchImpl: async () => {
      const posts = [makePost(1), makePost(2)];
      posts[0].public_metrics.impression_count = 7_000;
      return jsonResponse({
        data: posts,
        includes: { users: [makeUser(1), makeUser(2)] },
        meta: { result_count: posts.length },
      });
    },
  });

  assert.equal(result.posts.length, 2);
  assert.equal(result.rankablePosts.length, 1);
  assert.equal(result.meta.topicQualityPassed, 1);
  assert.equal(result.meta.qualityPassed, 1);
  assert.equal(result.posts.some((post) => post.id === "1001"), true);
  assert.equal(result.rankablePosts.some((post) => post.id === "1001"), false);
});

test("hybrid search gives topic discovery the full budget when followed accounts are quiet", async () => {
  const calls = [];
  const topicIndexes = Array.from({ length: 20 }, (_, index) => index + 1);

  const result = await searchHybridRecentPosts({
    query: "AI workaround lang:en -is:retweet",
    followedUsernames: ["quiet_account"],
    startTime: "2026-08-26T13:00:00Z",
    endTime: "2026-08-27T13:00:00Z",
    qualityTime: "2026-08-27T13:00:00Z",
    candidateLimit: 20,
    aiInputLimit: 20,
    fetchImpl: async (requestUrl) => {
      const url = new URL(requestUrl);
      const query = url.searchParams.get("query");
      calls.push({ query, maxResults: url.searchParams.get("max_results") });

      if (query.includes("from:quiet_account")) {
        return jsonResponse({ meta: { result_count: 0 } });
      }

      return jsonResponse({
        data: topicIndexes.map(makePost),
        includes: { users: topicIndexes.map(makeUser) },
        meta: { result_count: topicIndexes.length },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].maxResults, "10");
  assert.equal(calls[1].maxResults, "20");
  assert.equal(result.meta.followedReturned, 0);
  assert.equal(result.meta.topicRequestedLimit, 20);
  assert.equal(result.posts.length, 20);
  assert.ok(result.posts.every((post) => post.source_channel === "topic"));
});

test("hybrid search preserves followed-request rate-limit failures", async () => {
  let callCount = 0;

  await assert.rejects(
    searchHybridRecentPosts({
      query: "AI problem lang:en -is:retweet",
      followedUsernames: ["OpenAI"],
      startTime: "2026-08-26T13:00:00Z",
      endTime: "2026-08-27T13:00:00Z",
      qualityTime: "2026-08-27T13:00:00Z",
      candidateLimit: 50,
      aiInputLimit: 25,
      fetchImpl: async () => {
        callCount += 1;
        return jsonResponse(
          { title: "Too Many Requests" },
          { status: 429, headers: { "retry-after": "5" } },
        );
      },
    }),
    (error) => error instanceof XApiError && error.isRateLimited,
  );

  assert.equal(callCount, 1);
});

test("searchRecentPosts requests two relevancy pages and normalizes IDs", async () => {
  const calls = [];
  const fetchImpl = async (requestUrl, options) => {
    const url = new URL(requestUrl);
    calls.push({ url, options });
    const isSecondPage = url.searchParams.has("next_token");
    const start = isSecondPage ? 101 : 1;
    const end = isSecondPage ? 200 : 100;
    const indexes = Array.from(
      { length: end - start + 1 },
      (_, offset) => start + offset,
    );

    return jsonResponse({
      data: indexes.map(makePost),
      includes: { users: indexes.map(makeUser) },
      meta: isSecondPage
        ? { result_count: 100 }
        : { result_count: 100, next_token: "next-page" },
    });
  };

  const result = await searchRecentPosts({
    query: "AI problem lang:en -is:retweet",
    startTime: "2026-08-20T13:00:00Z",
    endTime: "2026-08-27T13:00:00Z",
    limit: 500,
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(result.posts.length, 200);
  assert.equal(result.meta.requestedLimit, 200);
  assert.equal(result.meta.pagesFetched, 2);
  assert.equal(result.partial, false);
  assert.equal(result.posts[0].id, "1001");
  assert.equal(typeof result.posts[0].id, "string");
  assert.equal(typeof result.posts[0].author_id, "string");
  assert.equal(typeof result.posts[0].conversation_id, "string");
  assert.equal(result.posts[0].author_username, "author_1");
  assert.equal(result.posts[0].url, "https://x.com/author_1/status/1001");
  assert.deepEqual(result.posts[0].public_metrics, {
    impression_count: 51_000,
    reply_count: 3,
    like_count: 1,
    bookmark_count: 4,
  });
  assert.equal(Object.hasOwn(result.posts[0].public_metrics, "retweet_count"), false);
  assert.equal(Object.hasOwn(result.posts[0].public_metrics, "quote_count"), false);
  assert.equal(result.posts[0].search_position, 1);
  assert.equal(result.posts[199].search_position, 200);

  const firstParams = calls[0].url.searchParams;
  assert.equal(calls[0].url.origin, "https://api.x.com");
  assert.equal(calls[0].url.pathname, "/2/tweets/search/recent");
  assert.equal(firstParams.get("sort_order"), "relevancy");
  assert.equal(firstParams.get("max_results"), "100");
  assert.equal(firstParams.get("tweet.fields"), X_POST_FIELDS.join(","));
  assert.equal(firstParams.get("expansions"), X_EXPANSIONS.join(","));
  assert.equal(firstParams.get("user.fields"), X_USER_FIELDS.join(","));
  assert.equal(firstParams.has("next_token"), false);
  assert.equal(calls[1].url.searchParams.get("next_token"), "next-page");
});

test("searchRecentPosts returns a safe partial result after at least 50 posts", async () => {
  let callCount = 0;
  const resetEpoch = Math.floor(Date.now() / 1_000) + 30;
  const indexes = Array.from({ length: 60 }, (_, index) => index + 1);

  const result = await searchRecentPosts({
    query: "AI workaround lang:en",
    startTime: "2026-08-26T13:00:00Z",
    endTime: "2026-08-27T13:00:00Z",
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return jsonResponse({
          data: indexes.map(makePost),
          includes: { users: indexes.map(makeUser) },
          meta: { result_count: 60, next_token: "more" },
        });
      }

      return jsonResponse(
        { title: "Too Many Requests" },
        {
          status: 429,
          headers: { "x-rate-limit-reset": String(resetEpoch) },
        },
      );
    },
  });

  assert.equal(result.posts.length, 60);
  assert.equal(result.partial, true);
  assert.equal(result.meta.pagesFetched, 1);
  assert.deepEqual(result.partialError, {
    status: 429,
    retryAfterMs: result.partialError.retryAfterMs,
    rateLimitResetAt: new Date(resetEpoch * 1_000).toISOString(),
    rateLimitResetEpochSeconds: resetEpoch,
  });
});

test("searchRecentPosts throws when a failed second page leaves fewer than 50 posts", async () => {
  let callCount = 0;
  const indexes = Array.from({ length: 49 }, (_, index) => index + 1);

  await assert.rejects(
    searchRecentPosts({
      query: "AI request lang:en",
      startTime: "2026-08-26T13:00:00Z",
      endTime: "2026-08-27T13:00:00Z",
      fetchImpl: async () => {
        callCount += 1;
        if (callCount === 1) {
          return jsonResponse({
            data: indexes.map(makePost),
            includes: { users: indexes.map(makeUser) },
            meta: { result_count: 49, next_token: "more" },
          });
        }

        return jsonResponse({ title: "Unavailable" }, { status: 503 });
      },
    }),
    (error) => error instanceof XApiError && error.status === 503,
  );
});

test("lookupPosts batches at 100 and reports omitted posts as unavailable", async () => {
  const requestedIds = Array.from({ length: 205 }, (_, index) =>
    String(1_001 + index),
  );
  const omittedId = "1101";
  const batchSizes = [];

  const result = await lookupPosts({
    ids: [...requestedIds, requestedIds[0]],
    fetchImpl: async (requestUrl) => {
      const url = new URL(requestUrl);
      const ids = url.searchParams.get("ids").split(",");
      batchSizes.push(ids.length);
      const indexes = ids
        .filter((id) => id !== omittedId)
        .map((id) => Number(id) - 1_000);
      const containsMissing = ids.includes(omittedId);

      assert.equal(url.pathname, "/2/tweets");
      assert.equal(url.searchParams.get("tweet.fields"), X_POST_FIELDS.join(","));
      assert.equal(url.searchParams.get("expansions"), "author_id");
      assert.equal(url.searchParams.get("user.fields"), "username");

      return jsonResponse({
        data: indexes.map(makePost),
        includes: { users: indexes.map(makeUser) },
        errors: containsMissing
          ? [
              {
                resource_id: omittedId,
                status: "404",
                title: "Not Found Error",
                detail: `Could not find post ${omittedId}`,
              },
            ]
          : [],
      });
    },
  });

  assert.deepEqual(batchSizes, [100, 100, 5]);
  assert.equal(result.meta.requestedCount, 205);
  assert.equal(result.meta.resultCount, 204);
  assert.equal(result.meta.batchesFetched, 3);
  assert.deepEqual(result.missingIds, [omittedId]);
  assert.deepEqual(result.unavailableIds, [omittedId]);
  assert.deepEqual(result.unknownIds, []);
  assert.deepEqual(result.errors, [
    {
      id: omittedId,
      status: 404,
      title: "Post unavailable",
      availability: "unavailable",
    },
  ]);
  assert.equal(result.posts[0].id, "1001");
  assert.ok(result.posts.every((post) => typeof post.id === "string"));
});

test("lookupPosts does not treat ambiguous omissions as unavailable", async () => {
  const result = await lookupPosts({
    ids: ["1001", "1002", "1003", "1004"],
    fetchImpl: async () => jsonResponse({
      data: [makePost(1)],
      includes: { users: [makeUser(1)] },
      errors: [
        {
          resource_id: "1002",
          status: 403,
          title: "Forbidden",
          type: "https://api.x.com/2/problems/not-authorized-for-resource",
        },
        {
          resource_id: "1003",
          title: "Not Found Error",
          type: "https://api.x.com/2/problems/resource-not-found",
        },
      ],
    }),
  });

  assert.deepEqual(result.unavailableIds, ["1003"]);
  assert.deepEqual(result.missingIds, ["1003"]);
  assert.deepEqual(result.unknownIds, ["1002", "1004"]);
  assert.deepEqual(result.errors, [
    {
      id: "1002",
      status: 403,
      title: "X lookup error",
      availability: "unknown",
    },
    {
      id: "1003",
      status: null,
      title: "Post unavailable",
      availability: "unavailable",
    },
  ]);
});
