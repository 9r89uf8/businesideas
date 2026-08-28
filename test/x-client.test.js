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
  xRequest,
} = await import("../src/lib/x/client.js");
const { getRecentSearchWindow, searchRecentPosts } = await import(
  "../src/lib/x/search-posts.js"
);
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
      like_count: index,
      retweet_count: 2,
      reply_count: 3,
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

test("getRecentSearchWindow adds overlap and caps the recent-search boundary", () => {
  assert.deepEqual(
    getRecentSearchWindow({
      previousWindowEnd: "2026-08-27T09:00:00Z",
      endTime: "2026-08-27T13:00:00Z",
      currentTime: "2026-08-28T13:00:00Z",
    }),
    {
      startTime: "2026-08-27T07:00:00Z",
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
      startTime: "2026-08-26T12:59:30Z",
      endTime: "2026-08-27T12:59:30Z",
    },
  );
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
