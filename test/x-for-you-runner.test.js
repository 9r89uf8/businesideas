import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const RUN_ID = "20000000-0000-4000-8000-000000000002";
const RUN_TIME = "2026-09-15T12:00:00.000Z";

const DEFAULT_OPTIONS = Object.freeze({
  maximumScrolls: 5,
  maximumNoGrowthCycles: 2,
  maximumRuntimeMs: 10_000,
  loadWaitMs: 250,
  stateTimeoutMs: 1_000,
  manualActionTimeoutMs: 10_000,
  interactiveChallenges: false,
  includeRawText: false,
  saveFailureScreenshot: false,
});

const POSTS = Object.freeze([
  Object.freeze({
    postId: "101",
    canonicalUrl: "https://x.com/author_101/status/101",
    authorHandle: "@author_101",
    authorDisplayName: "Author 101",
    text: "First synthetic timeline observation.",
    createdAt: "2026-09-15T11:00:00.000Z",
    observedAt: "2026-09-15T12:00:00.000Z",
    feedPosition: 1,
    hasMedia: false,
    mediaUrls: Object.freeze([]),
    isRepost: false,
    isPromoted: false,
  }),
  Object.freeze({
    postId: "102",
    canonicalUrl: "https://x.com/author_102/status/102",
    authorHandle: "@author_102",
    authorDisplayName: "Author 102",
    text: "Second synthetic timeline observation.",
    createdAt: "2026-09-15T11:30:00.000Z",
    observedAt: "2026-09-15T12:00:01.000Z",
    feedPosition: 2,
    hasMedia: false,
    mediaUrls: Object.freeze([]),
    isRepost: false,
    isPromoted: false,
  }),
]);

function proxyModule(moduleUrl, names) {
  return `export { ${names.join(", ")} } from ${JSON.stringify(moduleUrl)};\n`;
}

async function writeHarnessModule(directory, fileName, source) {
  await writeFile(join(directory, fileName), source, "utf8");
}

async function loadRunnerWithFakes(
  t,
  {
    closeError = null,
    accountError = null,
    capabilityErrorAtCheck = null,
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "tx1000-x-runner-"));
  const outputDirectory = join(directory, "output");
  const harnessKey = `__tx1000XRunnerHarness_${randomUUID().replaceAll("-", "")}`;
  const capability = Object.freeze({ testCapability: true });
  const page = Object.freeze({ testPage: true });
  const calls = {
    capabilityChecks: 0,
    launches: 0,
    navigationInstalls: 0,
    navigationChecks: 0,
    authentication: 0,
    accountChecks: 0,
    feedSelections: 0,
    collections: 0,
    diagnostics: 0,
    closes: 0,
  };
  const state = {
    capability,
    page,
    calls,
    posts: POSTS,
    scrollCycles: 3,
    collectionStopReason: "TARGET_REACHED",
    authenticationMethod: "existing-session",
    accountError,
    capabilityErrorAtCheck,
    authorized: Object.freeze({
      configuredAccount: "@approved_acct",
      approvedAccount: "@approved_acct",
      requestedPostLimit: POSTS.length,
      runId: RUN_ID,
      startedAt: RUN_TIME,
      runtimePaths: Object.freeze({ outputDirectory }),
    }),
  };
  state.context = Object.freeze({
    async close() {
      calls.closes += 1;
      if (closeError) throw closeError;
    },
  });
  globalThis[harnessKey] = state;

  t.after(async () => {
    delete globalThis[harnessKey];
    await rm(directory, { recursive: true, force: true });
  });

  const runnerSource = await readFile(
    new URL("../src/lib/x/for-you/runner.js", import.meta.url),
    "utf8",
  );
  const stateAccessor = `const harness = () => globalThis[${JSON.stringify(harnessKey)}];\n`;

  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeHarnessModule(directory, "package.json", '{"type":"module"}\n'),
    writeHarnessModule(directory, "runner.js", runnerSource),
    writeHarnessModule(
      directory,
      "preflight.js",
      `${stateAccessor}
       export function assertVerifiedCapability(capability) {
         const state = harness();
         assertIdentity(capability, state.capability);
         state.calls.capabilityChecks += 1;
         if (
           state.capabilityErrorAtCheck &&
           state.calls.capabilityChecks === state.capabilityErrorAtCheck.check
         ) {
           throw state.capabilityErrorAtCheck.error;
         }
         return state.authorized;
       }
       function assertIdentity(actual, expected) {
         if (actual !== expected) throw new Error("unexpected test capability");
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "browser.js",
      `${stateAccessor}
       export async function launchAuthorizedChrome(capability) {
         const state = harness();
         if (capability !== state.capability) throw new Error("unexpected test capability");
         state.calls.launches += 1;
         return {
           context: state.context,
           page: state.page,
           assertNoUnexpectedPages() { return true; },
         };
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "browser-close.js",
      proxyModule(
        new URL("../src/lib/x/for-you/browser-close.js", import.meta.url).href,
        ["closeBrowserContext"],
      ),
    ),
    writeHarnessModule(
      directory,
      "login.js",
      `${stateAccessor}
       export async function ensureXAuthenticated(page, options) {
         const state = harness();
         if (page !== state.page) throw new Error("unexpected test page");
         state.calls.authentication += 1;
         options.assertPermissionActive();
         return state.authenticationMethod;
       }
       export async function requireAuthenticatedAccount(page, expectedAccount) {
         const state = harness();
         if (page !== state.page) throw new Error("unexpected test page");
         if (expectedAccount !== state.authorized.configuredAccount) {
           throw new Error("unexpected approved account");
         }
         state.calls.accountChecks += 1;
         if (state.accountError) throw state.accountError;
         return expectedAccount;
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "feed.js",
      `${stateAccessor}
       export async function selectForYouFeed(page, options) {
         const state = harness();
         if (page !== state.page) throw new Error("unexpected test page");
         state.calls.feedSelections += 1;
         options.assertPermissionActive();
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "navigation.js",
      `${stateAccessor}
       export async function installNavigationGuard(page) {
         const state = harness();
         if (page !== state.page) throw new Error("unexpected test page");
         state.calls.navigationInstalls += 1;
         return Object.freeze({
           assertSafe() {
             state.calls.navigationChecks += 1;
           },
           completeLogin() {},
         });
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "collect.js",
      `${stateAccessor}
       export async function collectForYouPosts(page, options) {
         const state = harness();
         if (page !== state.page) throw new Error("unexpected test page");
         state.calls.collections += 1;
         options.assertPermissionActive();
         await options.assertAuthenticatedAccount();
         for (const post of state.posts) await options.onPost(post);
         return Object.freeze({
           posts: state.posts,
           scrollCycles: state.scrollCycles,
           stopReason: state.collectionStopReason,
         });
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "diagnostics.js",
      `${stateAccessor}
       export async function saveFailureDiagnostics() {
         harness().calls.diagnostics += 1;
         return Object.freeze({});
       }
      `,
    ),
    writeHarnessModule(
      directory,
      "logging.js",
      proxyModule(
        new URL("../src/lib/x/for-you/logging.js", import.meta.url).href,
        ["safeErrorFields"],
      ),
    ),
    writeHarnessModule(
      directory,
      "output.js",
      proxyModule(
        new URL("../src/lib/x/for-you/output.js", import.meta.url).href,
        ["createJsonlOutput", "writeRunMetadata"],
      ),
    ),
    writeHarnessModule(
      directory,
      "runtime-options.js",
      proxyModule(
        new URL("../src/lib/x/for-you/runtime-options.js", import.meta.url).href,
        ["validateCollectorRuntimeOptions"],
      ),
    ),
  ]);

  const runner = await import(
    `${pathToFileURL(join(directory, "runner.js")).href}?fixture=${randomUUID()}`,
  );
  return { runner, state, outputDirectory };
}

test("runner writes run IDs and approved-account metadata", async (t) => {
  const { runner, state, outputDirectory } = await loadRunnerWithFakes(t);
  const events = [];

  const outcome = await runner.runAuthorizedCollector({
    capability: state.capability,
    env: {},
    options: DEFAULT_OPTIONS,
    clock: () => new Date(RUN_TIME),
    log(event, fields) {
      events.push({ event, fields });
    },
  });

  const rows = (await readFile(
    join(outputDirectory, `${RUN_ID}.posts.jsonl`),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  const metadata = JSON.parse(await readFile(
    join(outputDirectory, `${RUN_ID}.run.json`),
    "utf8",
  ));

  assert.deepEqual(rows.map(({ runId, postId, feedPosition, observedAt }) => ({
    runId,
    postId,
    feedPosition,
    observedAt,
  })), [
    {
      runId: RUN_ID,
      postId: "101",
      feedPosition: 1,
      observedAt: "2026-09-15T12:00:00.000Z",
    },
    {
      runId: RUN_ID,
      postId: "102",
      feedPosition: 2,
      observedAt: "2026-09-15T12:00:01.000Z",
    },
  ]);
  assert.deepEqual(metadata, {
    runId: RUN_ID,
    approvedAccount: "@approved_acct",
    startedAt: RUN_TIME,
    completedAt: RUN_TIME,
    requestedPosts: 2,
    uniquePosts: 2,
    scrollCycles: 3,
    stopReason: "TARGET_REACHED",
    authenticatedUsing: "existing-session",
    failureCategory: null,
  });
  assert.deepEqual(outcome.metadata, metadata);
  assert.equal(outcome.postsFileName, `${RUN_ID}.posts.jsonl`);
  assert.equal(outcome.metadataFileName, `${RUN_ID}.run.json`);
  assert.deepEqual(outcome.candidates, [
    { postId: "101", feedPosition: 1 },
    { postId: "102", feedPosition: 2 },
  ]);
  assert.equal(state.calls.launches, 1);
  assert.equal(state.calls.authentication, 1);
  assert.equal(state.calls.accountChecks, 2);
  assert.equal(state.calls.feedSelections, 1);
  assert.equal(state.calls.collections, 1);
  assert.equal(state.calls.closes, 1);
  assert.equal(state.calls.diagnostics, 0);
  assert.deepEqual(events, [
    {
      event: "RUN_COMPLETED",
      fields: {
        runId: RUN_ID,
        uniquePosts: 2,
        scrollCycles: 3,
        stopReason: "TARGET_REACHED",
        outputFile: `${RUN_ID}.posts.jsonl`,
      },
    },
  ]);
});

test("runner stops before For You when the authenticated account mismatches", async (t) => {
  const accountError = new Error("synthetic account mismatch");
  accountError.code = "AUTH_ACCOUNT_MISMATCH";
  const { runner, state, outputDirectory } = await loadRunnerWithFakes(t, {
    accountError,
  });

  await assert.rejects(
    runner.runAuthorizedCollector({
      capability: state.capability,
      env: {},
      options: DEFAULT_OPTIONS,
      clock: () => new Date(RUN_TIME),
    }),
    (error) => error === accountError,
  );

  const metadata = JSON.parse(await readFile(
    join(outputDirectory, `${RUN_ID}.run.json`),
    "utf8",
  ));
  assert.equal(metadata.stopReason, "AUTH_ACCOUNT_MISMATCH");
  assert.equal(metadata.failureCategory, "AUTH_ACCOUNT_MISMATCH");
  assert.equal(state.calls.accountChecks, 1);
  assert.equal(state.calls.feedSelections, 0);
  assert.equal(state.calls.collections, 0);
  assert.equal(state.calls.closes, 1);
});

test("authorization revocation closes Chrome without reading page diagnostics", async (t) => {
  const revoked = new Error("synthetic authorization revocation");
  revoked.code = "FEATURE_DISABLED";
  const { runner, state, outputDirectory } = await loadRunnerWithFakes(t, {
    capabilityErrorAtCheck: { check: 4, error: revoked },
  });

  await assert.rejects(
    runner.runAuthorizedCollector({
      capability: state.capability,
      env: {},
      options: DEFAULT_OPTIONS,
      clock: () => new Date(RUN_TIME),
    }),
    (error) => error === revoked,
  );

  const metadata = JSON.parse(await readFile(
    join(outputDirectory, `${RUN_ID}.run.json`),
    "utf8",
  ));
  assert.equal(metadata.stopReason, "FEATURE_DISABLED");
  assert.equal(metadata.failureCategory, "FEATURE_DISABLED");
  assert.equal(state.calls.diagnostics, 0);
  assert.equal(state.calls.closes, 1);
});

test("runner records BROWSER_CLOSE_FAILED when Chrome shutdown is unconfirmed", async (t) => {
  const closeError = new Error("synthetic browser close failure");
  const { runner, state, outputDirectory } = await loadRunnerWithFakes(t, {
    closeError,
  });
  const events = [];

  await assert.rejects(
    runner.runAuthorizedCollector({
      capability: state.capability,
      env: {},
      options: DEFAULT_OPTIONS,
      clock: () => new Date(RUN_TIME),
      log(event, fields) {
        events.push({ event, fields });
      },
    }),
    (error) =>
      error !== closeError &&
      error?.code === "BROWSER_CLOSE_FAILED" &&
      /profile lock was retained/i.test(error.message),
  );

  const metadata = JSON.parse(await readFile(
    join(outputDirectory, `${RUN_ID}.run.json`),
    "utf8",
  ));
  assert.equal(metadata.stopReason, "BROWSER_CLOSE_FAILED");
  assert.equal(metadata.failureCategory, "BROWSER_CLOSE_FAILED");
  assert.equal(metadata.uniquePosts, POSTS.length);
  assert.equal(state.calls.closes, 1);
  assert.equal(state.calls.diagnostics, 0);
  assert.deepEqual(events, []);
});
