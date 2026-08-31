import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectForYouPosts,
  COLLECTION_STOP_REASONS,
  normalizeScrollLimits,
} from "../src/lib/x/for-you/collect.js";
import { saveFailureDiagnostics } from "../src/lib/x/for-you/diagnostics.js";
import {
  extractPostFromArticleElement,
  extractVisiblePosts,
  normalizeExtractedPost,
  normalizeXStatusUrl,
} from "../src/lib/x/for-you/extract-post.js";
import {
  createStructuredLogger,
  safeErrorFields,
} from "../src/lib/x/for-you/logging.js";
import {
  createJsonlOutput,
  sanitizeRunMetadata,
  writeRunMetadata,
} from "../src/lib/x/for-you/output.js";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const OBSERVED_AT = Date.parse("2026-09-15T12:00:00.000Z");
const SECRET_CANARY = "collector-secret-canary-must-not-be-written";

function rawPost(
  postId,
  {
    handle = `author_${postId}`,
    text = `Post ${postId} describes a concrete workflow problem in detail.`,
    mediaUrls = [],
    ...overrides
  } = {},
) {
  return {
    postId: String(postId),
    canonicalUrl: `https://x.com/${handle}/status/${postId}`,
    authorHandle: `@${handle}`,
    authorDisplayName: `Author ${postId}`,
    text,
    createdAt: "2026-09-15T11:00:00.000Z",
    mediaUrls,
    isRepost: false,
    isPromoted: false,
    ...overrides,
  };
}

function patternMatches(pattern, value) {
  if (pattern instanceof RegExp) {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }
  return pattern === value;
}

function visibilityLocator(
  visible,
  { descendantTextVisible = () => false } = {},
) {
  return {
    first() {
      return this;
    },
    async isVisible() {
      return visible;
    },
    async getAttribute(name) {
      return visible && name === "aria-selected" ? "true" : null;
    },
    async count() {
      return visible ? 1 : 0;
    },
    nth() {
      return this;
    },
    async evaluate(callback) {
      return callback({
        closest() {
          return null;
        },
      });
    },
    getByText(name) {
      return visibilityLocator(visible && descendantTextVisible(name));
    },
  };
}

function createCollectionPage({
  cycles = [[]],
  state = "authenticated",
  feedError = false,
} = {}) {
  let cycleIndex = 0;
  let activePosts = [];
  let scrollCalls = 0;
  let waitCalls = 0;

  function roleVisible(role, name) {
    if (
      state === "authenticated" &&
      role === "tab" &&
      patternMatches(name, "For you")
    ) {
      return true;
    }
    if (
      state === "login" &&
      role === "textbox" &&
      patternMatches(name, "Phone, email, or username")
    ) {
      return true;
    }
    if (
      state === "password" &&
      role === "textbox" &&
      patternMatches(name, "Password")
    ) {
      return true;
    }
    return false;
  }

  function textVisible(name) {
    return (
      (feedError && patternMatches(name, "Something went wrong")) ||
      (state === "username" &&
        patternMatches(name, "Enter your phone number or username"))
    );
  }

  function cssVisible(selector) {
    if (state === "authenticated") {
      return (
        selector === 'a[data-testid="AppTabBar_Home_Link"]' ||
        selector === 'main [data-testid="primaryColumn"]' ||
        (feedError && selector === 'main [role="alert"]')
      );
    }
    if (state === "login" || state === "username") {
      return (
        selector === 'input[autocomplete="username"]' ||
        selector === 'input[name="text"]'
      );
    }
    if (state === "password") {
      return (
        selector === 'input[name="password"]' ||
        selector === 'input[type="password"]'
      );
    }
    return false;
  }

  return {
    url() {
      return state === "challenge"
        ? "https://x.com/i/flow/challenge"
        : "https://x.com/home";
    },
    getByRole(role, options = {}) {
      return visibilityLocator(roleVisible(role, options.name));
    },
    getByText(name) {
      return visibilityLocator(textVisible(name));
    },
    locator(selector) {
      if (selector === 'main article[data-testid="tweet"]') {
        return {
          async count() {
            activePosts = cycles[cycleIndex] ?? cycles.at(-1) ?? [];
            cycleIndex += 1;
            return activePosts.length;
          },
          nth(index) {
            return {
              async isVisible() {
                return true;
              },
              async evaluate(_callback, includeRawText) {
                const post = activePosts[index];
                return includeRawText
                  ? post
                  : { ...post, rawAccessibleText: null };
              },
            };
          },
        };
      }
      return visibilityLocator(cssVisible(selector), {
        descendantTextVisible: textVisible,
      });
    },
    async evaluate() {
      scrollCalls += 1;
    },
    async waitForFunction() {
      waitCalls += 1;
      return true;
    },
    get scrollCalls() {
      return scrollCalls;
    },
    get waitCalls() {
      return waitCalls;
    },
  };
}

function domElement({
  embedded = false,
  attributes = {},
  text = "",
  query = {},
  currentSrc = "",
  src = "",
  poster = "",
} = {}) {
  return {
    innerText: text,
    textContent: text,
    currentSrc,
    src,
    poster,
    closest() {
      return embedded ? {} : null;
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    querySelector(selector) {
      return query[selector]?.[0] ?? null;
    },
    querySelectorAll(selector) {
      return query[selector] ?? [];
    },
  };
}

function quoteAndPrimaryArticle() {
  const quoteTime = domElement({
    embedded: true,
    attributes: { datetime: "2026-09-15T10:00:00.000Z" },
  });
  const primaryTime = domElement({
    attributes: { datetime: "2026-09-15T11:00:00.000Z" },
  });
  const quoteAnchor = domElement({
    embedded: true,
    attributes: { href: "/quoted_author/status/222" },
    query: { 'time[datetime]': [quoteTime] },
  });
  const primaryAnchor = domElement({
    attributes: { href: "/primary_author/status/111/photo/1" },
  });
  const quoteText = domElement({ embedded: true, text: "Quoted post text" });
  const primaryText = domElement({ text: "Primary post text" });
  const allowedImage = domElement({
    currentSrc: "https://pbs.twimg.com/media/allowed.jpg",
  });
  const externalImage = domElement({
    currentSrc: "https://tracking.example/secret.jpg",
  });
  const embeddedImage = domElement({
    embedded: true,
    currentSrc: "https://pbs.twimg.com/media/quoted.jpg",
  });
  const user = domElement({ text: "Primary Author\n@primary_author\n·\n1h" });
  const socialContext = domElement({ text: "Someone reposted" });

  return {
    ownerDocument: {
      documentElement: { clientWidth: 1280, clientHeight: 900 },
      defaultView: {
        innerWidth: 1280,
        innerHeight: 900,
        getComputedStyle() {
          return { display: "block", visibility: "visible" };
        },
      },
    },
    hidden: false,
    getBoundingClientRect() {
      return {
        top: 100,
        bottom: 400,
        left: 50,
        right: 900,
        width: 850,
        height: 300,
      };
    },
    getAttribute() {
      return null;
    },
    innerText:
      "Primary Author @primary_author Primary post text Quoted post text",
    textContent:
      "Primary Author @primary_author Primary post text Quoted post text",
    querySelector(selector) {
      if (selector === '[data-testid="User-Name"]') return user;
      if (selector === '[data-testid="socialContext"]') return socialContext;
      return null;
    },
    querySelectorAll(selector) {
      switch (selector) {
        case 'a[href*="/status/"]':
          // The embedded quote deliberately appears first in DOM order.
          return [quoteAnchor, primaryAnchor];
        case "time[datetime]":
          return [quoteTime, primaryTime];
        case '[data-testid="tweetText"]':
          return [quoteText, primaryText];
        case '[data-testid="tweetPhoto"] img':
          return [allowedImage, externalImage, embeddedImage];
        case "video[poster]":
        case "span":
          return [];
        default:
          return [];
      }
    },
  };
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("status and extracted-post normalization rejects noncanonical identities and external media", () => {
  assert.deepEqual(normalizeXStatusUrl("/@bad/status/1"), null);
  assert.deepEqual(normalizeXStatusUrl("http://x.com/author/status/1"), null);
  assert.deepEqual(
    normalizeXStatusUrl("https://x.com:444/author/status/1"),
    null,
  );
  assert.deepEqual(
    normalizeXStatusUrl("https://credential@x.com/author/status/1"),
    null,
  );
  assert.deepEqual(
    normalizeXStatusUrl("https://x.com.evil.example/author/status/1"),
    null,
  );
  assert.deepEqual(
    normalizeXStatusUrl("https://twitter.com/Author_1/status/123/photo/1?x=1"),
    {
      authorHandle: "@Author_1",
      postId: "123",
      canonicalUrl: "https://x.com/Author_1/status/123",
    },
  );

  assert.equal(
    normalizeExtractedPost(rawPost("123", { authorHandle: "@different" })),
    null,
  );
  assert.equal(
    normalizeExtractedPost(rawPost("123", { postId: "124" })),
    null,
  );

  const post = normalizeExtractedPost(
    rawPost("123", {
      mediaUrls: [
        "https://pbs.twimg.com/media/a.jpg",
        "https://video.twimg.com/ext_tw_video/b.mp4?tag=12&token=secret#private",
        "https://x.com/media/c",
        "https://credential@pbs.twimg.com/media/hidden.jpg",
        "https://tracking.example/pixel.gif",
        "http://pbs.twimg.com/media/insecure.jpg",
        "https://pbs.twimg.com:444/media/wrong-port.jpg",
        "data:text/plain,not-media",
        "https://pbs.twimg.com/media/a.jpg",
      ],
    }),
  );

  assert.deepEqual(post.mediaUrls, [
    "https://pbs.twimg.com/media/a.jpg",
    "https://video.twimg.com/ext_tw_video/b.mp4?tag=12",
  ]);
  assert.equal(post.hasMedia, true);
  assert.ok(
    post.mediaUrls.every((value) =>
      ["pbs.twimg.com", "video.twimg.com"].includes(
        new URL(value).hostname,
      ),
    ),
  );
});

test("article evaluation prefers the top-level status and content over a quoted post", async () => {
  const article = quoteAndPrimaryArticle();
  const page = {
    locator(selector) {
      assert.equal(selector, 'main article[data-testid="tweet"]');
      return {
        async count() {
          return 1;
        },
        nth(index) {
          assert.equal(index, 0);
          return {
            async isVisible() {
              return true;
            },
            async evaluate(callback, includeRawText) {
              assert.equal(callback, extractPostFromArticleElement);
              return callback(article, includeRawText);
            },
          };
        },
      };
    },
  };

  const posts = await extractVisiblePosts(page, { includeRawText: true });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].postId, "111");
  assert.equal(posts[0].canonicalUrl, "https://x.com/primary_author/status/111");
  assert.equal(posts[0].authorHandle, "@primary_author");
  assert.equal(posts[0].authorDisplayName, "Primary Author");
  assert.equal(posts[0].text, "Primary post text");
  assert.equal(posts[0].createdAt, "2026-09-15T11:00:00.000Z");
  assert.equal(posts[0].isRepost, true);
  assert.deepEqual(posts[0].mediaUrls, [
    "https://pbs.twimg.com/media/allowed.jpg",
  ]);
  assert.doesNotMatch(posts[0].rawAccessibleText, /Quoted post text/);
});

test("article evaluation ignores rendered posts outside the viewport", async () => {
  const article = quoteAndPrimaryArticle();
  article.getBoundingClientRect = () => ({
    top: 1_000,
    bottom: 1_300,
    left: 50,
    right: 900,
    width: 850,
    height: 300,
  });
  const page = {
    locator() {
      return {
        async count() {
          return 1;
        },
        nth() {
          return {
            async isVisible() {
              return true;
            },
            async evaluate(callback, includeRawText) {
              return callback(article, includeRawText);
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await extractVisiblePosts(page), []);
});

test("article extraction caps a drifted DOM before reading unbounded candidates", async () => {
  let candidateReads = 0;
  const page = {
    locator() {
      return {
        async count() {
          return 10_000;
        },
        nth() {
          candidateReads += 1;
          return {
            async isVisible() {
              return false;
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await extractVisiblePosts(page), []);
  assert.equal(candidateReads, 40);
});

test("collection keeps the first observation and assigns stable feed order", async () => {
  const page = createCollectionPage({
    cycles: [
      [rawPost("1"), rawPost("1", { text: "duplicate in first cycle" })],
      [rawPost("1", { text: "later changed text" }), rawPost("2")],
    ],
  });
  const emitted = [];
  let permissionChecks = 0;

  const result = await collectForYouPosts(page, {
    limits: {
      targetUniquePosts: 2,
      maximumScrolls: 5,
      maximumNoGrowthCycles: 3,
      maximumRuntimeMs: 10_000,
      loadWaitMs: 250,
    },
    clock: () => OBSERVED_AT,
    assertPermissionActive() {
      permissionChecks += 1;
    },
    onPost(post) {
      emitted.push(post);
    },
  });

  assert.equal(result.stopReason, COLLECTION_STOP_REASONS.TARGET_REACHED);
  assert.equal(result.scrollCycles, 1);
  assert.equal(page.scrollCalls, 1);
  assert.equal(page.waitCalls, 1);
  assert.ok(permissionChecks >= 5);
  assert.deepEqual(result.posts.map((post) => post.postId), ["1", "2"]);
  assert.deepEqual(result.posts.map((post) => post.feedPosition), [1, 2]);
  assert.equal(result.posts[0].text, rawPost("1").text);
  assert.equal(result.posts[0].observedAt, "2026-09-15T12:00:00.000Z");
  assert.deepEqual(emitted, result.posts);
});

test("collection reports each bounded scroll stop condition", async (t) => {
  await t.test("maximum scrolls", async () => {
    const page = createCollectionPage({ cycles: [[]] });
    const result = await collectForYouPosts(page, {
      limits: {
        targetUniquePosts: 1,
        maximumScrolls: 0,
        maximumNoGrowthCycles: 2,
        maximumRuntimeMs: 1_000,
        loadWaitMs: 250,
      },
      clock: () => 0,
    });
    assert.equal(result.stopReason, COLLECTION_STOP_REASONS.MAXIMUM_SCROLLS);
    assert.equal(result.scrollCycles, 0);
  });

  await t.test("maximum runtime", async () => {
    const page = createCollectionPage({ cycles: [[]] });
    const times = [0, 1_000];
    let call = 0;
    const result = await collectForYouPosts(page, {
      limits: {
        targetUniquePosts: 1,
        maximumScrolls: 5,
        maximumNoGrowthCycles: 2,
        maximumRuntimeMs: 1_000,
        loadWaitMs: 250,
      },
      clock: () => times[Math.min(call++, times.length - 1)],
    });
    assert.equal(result.stopReason, COLLECTION_STOP_REASONS.MAXIMUM_RUNTIME);
    assert.equal(result.scrollCycles, 0);
  });

  await t.test("no feed growth", async () => {
    const page = createCollectionPage({ cycles: [[], []] });
    const events = [];
    const result = await collectForYouPosts(page, {
      limits: {
        targetUniquePosts: 1,
        maximumScrolls: 5,
        maximumNoGrowthCycles: 2,
        maximumRuntimeMs: 1_000,
        loadWaitMs: 250,
      },
      clock: () => 0,
      log(event, fields) {
        events.push({ event, fields });
      },
    });
    assert.equal(result.stopReason, COLLECTION_STOP_REASONS.NO_FEED_GROWTH);
    assert.equal(result.scrollCycles, 1);
    assert.deepEqual(events, [
      { event: "NO_FEED_GROWTH", fields: { noGrowthCycles: 2 } },
    ]);
  });
});

test("scroll limit normalization enforces the collector's hard bounds", () => {
  assert.deepEqual(normalizeScrollLimits({ targetUniquePosts: 2 }), {
    targetUniquePosts: 2,
    maximumScrolls: 60,
    maximumNoGrowthCycles: 5,
    maximumRuntimeMs: 300_000,
    loadWaitMs: 2_500,
  });
  assert.throws(
    () => normalizeScrollLimits({ targetUniquePosts: 101 }),
    /targetUniquePosts/,
  );
  assert.throws(
    () => normalizeScrollLimits({ targetUniquePosts: 1, loadWaitMs: 249 }),
    /loadWaitMs/,
  );
});

test("collection fails closed for challenges, expired sessions, and feed errors", async (t) => {
  const cases = [
    { name: "challenge", page: { state: "challenge" }, code: "MANUAL_ACTION_REQUIRED" },
    { name: "expired session", page: { state: "login" }, code: "SESSION_EXPIRED" },
    { name: "feed error", page: { feedError: true }, code: "FEED_ERROR" },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const page = createCollectionPage({ cycles: [[rawPost("1")]], ...fixture.page });
      await assert.rejects(
        collectForYouPosts(page, {
          limits: {
            targetUniquePosts: 1,
            maximumScrolls: 1,
            maximumNoGrowthCycles: 1,
            maximumRuntimeMs: 1_000,
            loadWaitMs: 250,
          },
          clock: () => OBSERVED_AT,
        }),
        (error) => error?.code === fixture.code,
      );
      assert.equal(page.scrollCalls, 0);
    });
  }
});

test("authorization is rechecked within every collection cycle", async () => {
  const page = createCollectionPage({ cycles: [[], [rawPost("1")]] });
  let checks = 0;

  await assert.rejects(
    collectForYouPosts(page, {
      limits: {
        targetUniquePosts: 1,
        maximumScrolls: 2,
        maximumNoGrowthCycles: 2,
        maximumRuntimeMs: 1_000,
        loadWaitMs: 250,
      },
      clock: () => 0,
      assertPermissionActive() {
        checks += 1;
        if (checks === 3) {
          const error = new Error("authorization disabled");
          error.code = "FEATURE_DISABLED";
          throw error;
        }
      },
    }),
    (error) => error?.code === "FEATURE_DISABLED",
  );
  assert.equal(checks, 3);
  assert.equal(page.scrollCalls, 0);
});

test("collection stops before extraction when the live account changes", async () => {
  const page = createCollectionPage({ cycles: [[], [rawPost("1")]] });
  const emitted = [];
  let accountChecks = 0;

  await assert.rejects(
    collectForYouPosts(page, {
      limits: {
        targetUniquePosts: 1,
        maximumScrolls: 2,
        maximumNoGrowthCycles: 2,
        maximumRuntimeMs: 1_000,
        loadWaitMs: 250,
      },
      clock: () => 0,
      async assertAuthenticatedAccount() {
        accountChecks += 1;
        if (accountChecks === 2) {
          const error = new Error("synthetic account switch");
          error.code = "AUTH_ACCOUNT_MISMATCH";
          throw error;
        }
      },
      onPost(post) {
        emitted.push(post);
      },
    }),
    (error) => error?.code === "AUTH_ACCOUNT_MISMATCH",
  );

  assert.equal(accountChecks, 2);
  assert.equal(page.scrollCalls, 1);
  assert.deepEqual(emitted, []);
});

test("JSONL posts and run metadata omit supplied secret-bearing fields", async (t) => {
  const outputDirectory = await temporaryDirectory(t, "tx1000-x-output-");
  const output = await createJsonlOutput({ outputDirectory, runId: RUN_ID });
  await output.writePost({
    runId: RUN_ID,
    ...normalizeExtractedPost(rawPost("123")),
    observedAt: "2026-09-15T12:00:00.000Z",
    feedPosition: 1,
    mediaUrls: [
      "https://pbs.twimg.com/media/allowed.jpg",
      `https://tracking.example/${SECRET_CANARY}.jpg`,
    ],
    password: SECRET_CANARY,
    cookies: [{ value: SECRET_CANARY }],
    authorization: `Bearer ${SECRET_CANARY}`,
    profilePath: `C:/runtime/${SECRET_CANARY}`,
  });
  await output.close();

  await writeRunMetadata({
    outputDirectory,
    runId: RUN_ID,
    metadata: {
      runId: RUN_ID,
      approvedAccount: "@account",
      startedAt: "2026-09-15T12:00:00.000Z",
      completedAt: "2026-09-15T12:01:00.000Z",
      requestedPosts: 1,
      uniquePosts: 1,
      scrollCycles: 0,
      stopReason: "TARGET_REACHED",
      authenticatedUsing: "existing-session",
      failureCategory: null,
      password: SECRET_CANARY,
      cookies: [{ value: SECRET_CANARY }],
      authorization: `Bearer ${SECRET_CANARY}`,
      profilePath: `C:/runtime/${SECRET_CANARY}`,
    },
  });

  const jsonlText = await readFile(output.filePath, "utf8");
  const metadataText = await readFile(
    join(outputDirectory, `${RUN_ID}.run.json`),
    "utf8",
  );
  const post = JSON.parse(jsonlText.trim());
  const metadata = JSON.parse(metadataText);

  for (const text of [jsonlText, metadataText]) {
    assert.doesNotMatch(text, new RegExp(SECRET_CANARY));
    assert.doesNotMatch(text, /password|cookies|authorization|profilePath/i);
  }
  for (const key of ["password", "cookies", "authorization", "profilePath"]) {
    assert.equal(Object.hasOwn(post, key), false);
    assert.equal(Object.hasOwn(metadata, key), false);
  }
  assert.deepEqual(post.mediaUrls, [
    "https://pbs.twimg.com/media/allowed.jpg",
  ]);
});

test("structured logging emits only allowlisted scalar fields", () => {
  let output = "";
  const log = createStructuredLogger({
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    clock: () => new Date("2026-09-15T12:00:00.000Z"),
  });

  log("POSTS_COLLECTED", {
    added: 2,
    uniquePosts: 3,
    runId: RUN_ID,
    mode: { nested: SECRET_CANARY },
    password: SECRET_CANARY,
    cookies: SECRET_CANARY,
    authorization: SECRET_CANARY,
    profilePath: SECRET_CANARY,
  });

  const record = JSON.parse(output);
  assert.deepEqual(record, {
    timestamp: "2026-09-15T12:00:00.000Z",
    event: "POSTS_COLLECTED",
    added: 2,
    uniquePosts: 3,
    runId: RUN_ID,
  });
  assert.doesNotMatch(output, new RegExp(SECRET_CANARY));

  output = "";
  log(SECRET_CANARY, { password: SECRET_CANARY });
  assert.equal(JSON.parse(output).event, "UNKNOWN_EVENT");
  assert.doesNotMatch(output, new RegExp(SECRET_CANARY));

  const error = Object.assign(new Error(SECRET_CANARY), {
    code: "SELECTOR_DRIFT",
    locator: "for-you-tab",
    password: SECRET_CANARY,
  });
  assert.deepEqual(safeErrorFields(error), {
    errorCode: "SELECTOR_DRIFT",
    locator: "for-you-tab",
  });
  assert.deepEqual(
    safeErrorFields({ code: SECRET_CANARY, locator: SECRET_CANARY }),
    { errorCode: "COLLECTOR_FAILED" },
  );
});

test("run metadata rejects secret-bearing values in allowlisted fields", () => {
  assert.throws(
    () => sanitizeRunMetadata({
      runId: RUN_ID,
      approvedAccount: "@account",
      startedAt: "2026-09-15T12:00:00.000Z",
      completedAt: "2026-09-15T12:01:00.000Z",
      requestedPosts: 1,
      uniquePosts: 1,
      scrollCycles: 0,
      stopReason: SECRET_CANARY,
      authenticatedUsing: "existing-session",
      failureCategory: null,
    }),
    /metadata is invalid/i,
  );
});

test("failure diagnostics omit error text and URL secrets while masking sensitive UI", async (t) => {
  const outputDirectory = await temporaryDirectory(t, "tx1000-x-diagnostics-");
  let screenshotOptions = null;
  const page = {
    isClosed() {
      return false;
    },
    url() {
      return `https://x.com/home?token=${SECRET_CANARY}#${SECRET_CANARY}`;
    },
    async title() {
      return `Home / X ${SECRET_CANARY}`;
    },
    locator(selector) {
      return {
        selector,
        first() {
          return this;
        },
        async evaluate(callback) {
          assert.equal(selector, "main");
          return callback({
            tagName: "MAIN",
            children: [],
            getAttribute(name) {
              return name === "data-testid" ? "primaryColumn" : null;
            },
          });
        },
      };
    },
    async screenshot(options) {
      screenshotOptions = options;
      await writeFile(options.path, "sanitized screenshot fixture", "utf8");
    },
  };
  const error = Object.assign(new Error(SECRET_CANARY), {
    code: "SELECTOR_DRIFT",
    locator: "for-you-tab",
    password: SECRET_CANARY,
  });

  const saved = await saveFailureDiagnostics({
    page,
    outputDirectory,
    runId: RUN_ID,
    error,
    postsCollected: 7,
  });
  const diagnosticText = await readFile(
    join(outputDirectory, saved.diagnosticFileName),
    "utf8",
  );
  const diagnostic = JSON.parse(diagnosticText);

  assert.equal(diagnostic.currentUrl, "https://x.com/home");
  assert.equal(diagnostic.pageTitle, "[redacted]");
  assert.equal(
    diagnostic.sanitizedHtmlFragment,
    '<main data-testid="primaryColumn">',
  );
  assert.equal(diagnostic.failureCategory, "SELECTOR_DRIFT");
  assert.equal(diagnostic.failedLocator, "for-you-tab");
  assert.equal(diagnostic.postsCollected, 7);
  assert.doesNotMatch(diagnosticText, new RegExp(SECRET_CANARY));
  assert.equal(saved.screenshotFileName, `${RUN_ID}.failure.png`);
  assert.equal(screenshotOptions.fullPage, false);
  assert.equal(screenshotOptions.animations, "disabled");
  assert.deepEqual(
    screenshotOptions.mask.map((locator) => locator.selector),
    [
      "input",
      '[data-testid="SideNav_AccountSwitcher_Button"]',
      '[role="dialog"]',
      '[data-testid="DMDrawer"]',
    ],
  );
});

test("failure diagnostics never screenshot a non-X Home origin", async (t) => {
  const outputDirectory = await temporaryDirectory(t, "tx1000-x-diagnostics-origin-");
  let screenshots = 0;
  let pageReads = 0;
  const saved = await saveFailureDiagnostics({
    page: {
      isClosed: () => false,
      url: () => "https://attacker.example/home",
      async title() {
        pageReads += 1;
        return SECRET_CANARY;
      },
      locator() {
        pageReads += 1;
        throw new Error("external DOM must not be read");
      },
      async screenshot() {
        screenshots += 1;
      },
    },
    outputDirectory,
    runId: RUN_ID,
    error: Object.assign(new Error("blocked"), {
      code: "NAVIGATION_BLOCKED",
    }),
    postsCollected: 0,
  });

  assert.equal(saved.screenshotFileName, null);
  assert.equal(screenshots, 0);
  assert.equal(pageReads, 0);
  const diagnostic = JSON.parse(await readFile(
    join(outputDirectory, saved.diagnosticFileName),
    "utf8",
  ));
  assert.equal(diagnostic.currentUrl, "[blocked]");
});
