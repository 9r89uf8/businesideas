import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/workflows/daily-research-steps.js", import.meta.url),
  "utf8",
);

function loadExportedFunction(name) {
  const signature = `export function ${name}`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${name} must be exported`);

  const bodyStart = source.indexOf(") {", start) + 2;
  assert.ok(bodyStart > 1, `${name} must have a function body`);
  let depth = 0;
  let end = bodyStart;
  for (; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    if (source[end] === "}") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  const declaration = source.slice(start, end).replace(/^export /, "");
  return Function(`${declaration}; return ${name};`)();
}

test("X API discovery defaults on and only exact false disables it", () => {
  const isXApiDiscoveryEnabled = loadExportedFunction(
    "isXApiDiscoveryEnabled",
  );

  assert.equal(isXApiDiscoveryEnabled({}), true);
  assert.equal(
    isXApiDiscoveryEnabled({ X_API_DISCOVERY_ENABLED: "true" }),
    true,
  );
  assert.equal(
    isXApiDiscoveryEnabled({ X_API_DISCOVERY_ENABLED: "FALSE" }),
    true,
  );
  assert.equal(
    isXApiDiscoveryEnabled({ X_API_DISCOVERY_ENABLED: "false" }),
    false,
  );
});

test("For You-only mode requires a completed browser collection", () => {
  const assertForYouOnlyCollectionCompleted = loadExportedFunction(
    "assertForYouOnlyCollectionCompleted",
  );

  assert.doesNotThrow(() =>
    assertForYouOnlyCollectionCompleted({
      apiDiscoveryEnabled: true,
      forYouCollectionCompleted: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertForYouOnlyCollectionCompleted({
      apiDiscoveryEnabled: false,
      forYouCollectionCompleted: true,
    }),
  );
  assert.throws(
    () =>
      assertForYouOnlyCollectionCompleted({
        apiDiscoveryEnabled: false,
        forYouCollectionCompleted: false,
      }),
    /For You collection did not complete/,
  );
});

test("disabled API discovery builds a complete zeroed search baseline", () => {
  const buildZeroedXSearchResult = loadExportedFunction(
    "buildZeroedXSearchResult",
  );
  const result = buildZeroedXSearchResult({
    run: {
      window_start: "2026-08-29T00:00:00.000Z",
      window_end: "2026-09-01T00:00:00.000Z",
      settings_snapshot: { candidate_limit: 100 },
    },
    metricsCapturedAt: "2026-09-01T00:00:01.000Z",
  });

  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.rankablePosts, []);
  assert.equal(result.partial, false);
  assert.deepEqual(result.meta, {
    resultCount: 0,
    rawResultCount: 0,
    requestedLimit: 0,
    windowStart: "2026-08-29T00:00:00.000Z",
    windowEnd: "2026-09-01T00:00:00.000Z",
    metricsCapturedAt: "2026-09-01T00:00:01.000Z",
    followedAccountsConfigured: 0,
    followedQueryBatches: 0,
    followedRequestedLimit: 0,
    followedReturned: 0,
    followedBatchDuplicates: 0,
    followedQualityPassed: 0,
    topicRequestedLimit: 0,
    topicReturned: 0,
    topicQualityPassed: 0,
    qualityPassed: 0,
    crossChannelDuplicates: 0,
    pagesFetched: 0,
  });
});

test("workflow excludes historical owner posts and requires For You-only hydration", () => {
  assert.match(
    source,
    /apiDiscoveryEnabled\s*\?\s*await searchHybridRecentPosts\([\s\S]*?: buildZeroedXSearchResult\(/,
  );
  assert.match(
    source,
    /\.from\("posts"\)[\s\S]*?\.select\("x_post_id"\)[\s\S]*?\.eq\("owner_id", ownerId\)[\s\S]*?\.in\("x_post_id", candidateIds\)/,
  );
  assert.match(source, /return new Set\(candidateIds\.filter\(/);
  assert.match(
    source,
    /assertForYouOnlyCollectionCompleted\(\{[\s\S]*?apiDiscoveryEnabled,[\s\S]*?forYouCollectionCompleted/,
  );
  assert.match(source, /excludedPostIds,\s*\n\s*windowStart:/);
  assert.match(
    source,
    /if \(apiDiscoveryEnabled\) \{[\s\S]*?try \{[\s\S]*?await hydrateForYouPosts\(\)[\s\S]*?\} catch \{[\s\S]*?\}\s*\} else \{[\s\S]*?searchResult = await hydrateForYouPosts\(\)/,
  );

  for (const [count, metadata] of [
    ["x_for_you_already_seen", "forYouAlreadySeen"],
    ["x_for_you_replies_rejected", "forYouRepliesRejected"],
    ["x_for_you_limit_skipped", "forYouLimitSkipped"],
  ]) {
    assert.match(source, new RegExp(`${count}:\\s*searchResult\\.meta\\.${metadata}`));
  }
});
