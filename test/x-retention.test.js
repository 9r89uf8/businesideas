import assert from "node:assert/strict";
import { test } from "node:test";
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
  applyEvidenceLookupResult,
  getChangedPostTextIds,
  loadRetainedEvidenceSourceIds,
} = await import("../src/lib/x/retention.js");

test("getChangedPostTextIds finds only stored posts whose current text changed", () => {
  assert.deepEqual(
    getChangedPostTextIds(
      [
        { x_post_id: "101", text: "same" },
        { x_post_id: "102", text: "old" },
        { x_post_id: "103", text: null },
      ],
      [
        { id: "101", text: "same" },
        { id: "102", text: "new" },
        { id: "103", text: "restored" },
        { id: "104", text: "newly discovered" },
      ],
    ),
    ["102", "103"],
  );
});

test("applyEvidenceLookupResult clears changed and unavailable excerpts but preserves unknown content", async () => {
  const calls = [];
  const db = {
    from(table) {
      return {
        upsert(rows, options) {
          calls.push({ type: "upsert", table, rows, options });
          return Promise.resolve({ error: null });
        },
        update(updateValues) {
          const filters = [];
          const chain = {
            eq(field, value) {
              filters.push({ type: "eq", field, value });
              return chain;
            },
            in(field, values) {
              filters.push({ type: "in", field, values });
              calls.push({
                type: "update",
                table,
                values: updateValues,
                filters,
              });
              return Promise.resolve({ error: null });
            },
          };
          return chain;
        },
      };
    },
  };

  const result = await applyEvidenceLookupResult({
    db,
    ownerId: "11111111-1111-4111-8111-111111111111",
    now: "2026-08-27T13:00:00.000Z",
    existingPosts: [
      { x_post_id: "101", text: "old text" },
      { x_post_id: "102", text: "unchanged text" },
      { x_post_id: "103", text: "removed text" },
      { x_post_id: "104", text: "temporarily unverified" },
    ],
    result: {
      posts: [
        {
          id: "101",
          author_id: "201",
          author_username: "one",
          text: "edited text",
          url: "https://x.com/one/status/101",
          conversation_id: "101",
          lang: "en",
          created_at: "2026-08-26T13:00:00.000Z",
        },
        {
          id: "102",
          author_id: "202",
          author_username: "two",
          text: "unchanged text",
          url: "https://x.com/two/status/102",
          conversation_id: "102",
          lang: "en",
          created_at: "2026-08-26T13:00:00.000Z",
        },
      ],
      unavailableIds: ["103"],
      unknownIds: ["104"],
    },
  });

  assert.deepEqual(result, {
    changedIds: ["101"],
    unavailableIds: ["103"],
    unknownIds: ["104"],
  });

  const excerptUpdates = calls.filter(
    (call) => call.type === "update" && call.table === "run_posts",
  );
  assert.equal(excerptUpdates.length, 2);
  for (const call of excerptUpdates) {
    assert.deepEqual(call.values, { evidence_excerpt: null });
  }
  assert.deepEqual(
    excerptUpdates.flatMap((call) => call.filters.at(-1).values),
    ["101", "103"],
  );
  assert.ok(
    calls.findIndex(
      (call) => call.type === "update" && call.table === "run_posts",
    ) < calls.findIndex(
      (call) => call.type === "upsert" && call.table === "posts",
    ),
    "changed excerpts are cleared before the idempotent post upsert",
  );

  const postUpsert = calls.find(
    (call) => call.type === "upsert" && call.table === "posts",
  );
  assert.deepEqual(postUpsert.options, {
    onConflict: "x_post_id",
    ignoreDuplicates: false,
  });

  const postUpdates = calls.filter(
    (call) => call.type === "update" && call.table === "posts",
  );
  assert.equal(postUpdates.length, 2);
  assert.deepEqual(postUpdates[0].values, {
    availability: "unavailable",
    text: null,
    last_checked_at: "2026-08-27T13:00:00.000Z",
  });
  assert.deepEqual(postUpdates[1].values, { availability: "unknown" });
});

test("loadRetainedEvidenceSourceIds paginates beyond 5,000 links", async () => {
  const links = Array.from({ length: 5_005 }, (_, index) => ({
    idea_id: String(index).padStart(6, "0"),
    post_id: String(10_000 + (index % 5_003)),
  }));
  const ranges = [];
  const db = {
    from(table) {
      assert.equal(table, "idea_sources");
      const chain = {
        select() {
          return chain;
        },
        eq() {
          return chain;
        },
        order() {
          return chain;
        },
        range(from, to) {
          ranges.push([from, to]);
          return Promise.resolve({ data: links.slice(from, to + 1), error: null });
        },
      };
      return chain;
    },
  };

  const ids = await loadRetainedEvidenceSourceIds(
    db,
    "11111111-1111-4111-8111-111111111111",
  );

  assert.deepEqual(ranges, [
    [0, 999],
    [1_000, 1_999],
    [2_000, 2_999],
    [3_000, 3_999],
    [4_000, 4_999],
    [5_000, 5_999],
  ]);
  assert.equal(ids.length, 5_003);
});
