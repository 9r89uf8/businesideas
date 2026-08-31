import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  X_FOR_YOU_ERROR_CODES,
  isXForYouSafetyError,
} from "../src/lib/x/for-you/errors.js";
import {
  acquireProfileLock,
  assertActiveProfileLock,
  releaseProfileLock,
} from "../src/lib/x/for-you/profile-lock.js";
import {
  abandonVerifiedCapability,
  assertVerifiedCapability,
  authorizeCollectorRun,
  claimVerifiedCapabilityForBrowserLaunch,
  releaseVerifiedCapability,
  requireValidPermission,
  resolvePreflightConfig,
} from "../src/lib/x/for-you/preflight.js";
import { launchAuthorizedChrome } from "../src/lib/x/for-you/browser.js";
import { closeBrowserContext } from "../src/lib/x/for-you/browser-close.js";

const ACTIVE_TIME = new Date("2026-09-15T12:00:00.000Z");

function hasCode(code) {
  return (error) => isXForYouSafetyError(error, code);
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "tx1000-x-safety-"));
  const repositoryRoot = join(root, "repository");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(repositoryRoot, { recursive: true });

  return {
    root,
    repositoryRoot,
    runtimeDirectory,
    env: {
      X_WEB_AUTOMATION_ENABLED: "true",
      X_LOGIN_USERNAME: "@SignalFoundry",
      X_WEB_AUTOMATION_APPROVED_ACCOUNT: "@signalfoundry",
      X_WEB_AUTOMATION_POST_LIMIT: "100",
      X_WEB_AUTOMATION_RUNTIME_DIR: runtimeDirectory,
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("the feature flag is exact and fails before filesystem access", async () => {
  let filesystemCalls = 0;
  const fs = new Proxy({}, {
    get() {
      filesystemCalls += 1;
      throw new Error("filesystem must not be touched");
    },
  });

  for (const value of [undefined, "TRUE", " true", "true ", "1"]) {
    await assert.rejects(
      requireValidPermission({
        env: { X_WEB_AUTOMATION_ENABLED: value },
        repositoryRoot: process.cwd(),
        fs,
      }),
      hasCode(X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED),
    );
  }
  assert.equal(filesystemCalls, 0);
});

test("the approved account gate fails before filesystem access", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  let filesystemCalls = 0;
  const fs = new Proxy({}, {
    get() {
      filesystemCalls += 1;
      throw new Error("filesystem must not be touched");
    },
  });

  for (const env of [
    { ...fixture.env, X_WEB_AUTOMATION_APPROVED_ACCOUNT: "" },
    { ...fixture.env, X_WEB_AUTOMATION_APPROVED_ACCOUNT: "SignalFoundry" },
  ]) {
    await assert.rejects(
      requireValidPermission({ env, repositoryRoot: fixture.repositoryRoot, fs }),
      hasCode(X_FOR_YOU_ERROR_CODES.CONFIG_INVALID),
    );
  }
  await assert.rejects(
    requireValidPermission({
      env: {
        ...fixture.env,
        X_WEB_AUTOMATION_APPROVED_ACCOUNT: "@other_account",
      },
      repositoryRoot: fixture.repositoryRoot,
      fs,
    }),
    hasCode(X_FOR_YOU_ERROR_CODES.APPROVED_ACCOUNT_MISMATCH),
  );
  assert.equal(filesystemCalls, 0);
});

test("preflight requires an absolute runtime outside the repository", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const config = resolvePreflightConfig({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
  });
  assert.equal(config.runtimePaths.runtimeDirectory, fixture.runtimeDirectory);
  assert.equal(
    config.runtimePaths.profileDirectory,
    join(fixture.runtimeDirectory, "chrome-profile"),
  );

  assert.throws(
    () => resolvePreflightConfig({
      env: {
        ...fixture.env,
        X_WEB_AUTOMATION_RUNTIME_DIR: join(
          fixture.repositoryRoot,
          "runtime",
        ),
      },
      repositoryRoot: fixture.repositoryRoot,
    }),
    hasCode(X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE),
  );
  assert.throws(
    () => resolvePreflightConfig({
      env: {
        ...fixture.env,
        X_WEB_AUTOMATION_RUNTIME_DIR: "\\\\server\\share\\x-for-you",
      },
      repositoryRoot: fixture.repositoryRoot,
    }),
    hasCode(X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE),
  );
  if (process.platform === "win32") {
    assert.throws(
      () => resolvePreflightConfig({
        env: {
          ...fixture.env,
          X_WEB_AUTOMATION_RUNTIME_DIR: join(
            tmpdir(),
            "..",
            "..",
            "tx1000-outside-local-app-data",
          ),
        },
        repositoryRoot: fixture.repositoryRoot,
      }),
      hasCode(X_FOR_YOU_ERROR_CODES.RUNTIME_PATH_UNSAFE),
    );
  }

  const permission = await requireValidPermission({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  assert.equal(permission.config.approvedAccount, "@signalfoundry");
  await access(fixture.runtimeDirectory);
});

test("profile locks are exclusive, unforgeable, and explicitly released", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const lockFilePath = join(fixture.runtimeDirectory, "locks", "profile.lock");
  const first = await acquireProfileLock({ lockFilePath, now: ACTIVE_TIME });
  assert.equal(assertActiveProfileLock(first), true);
  assert.throws(
    () => assertActiveProfileLock(Object.freeze({})),
    hasCode(X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID),
  );
  await assert.rejects(
    acquireProfileLock({ lockFilePath, now: ACTIVE_TIME }),
    hasCode(X_FOR_YOU_ERROR_CODES.PROFILE_LOCKED),
  );

  await releaseProfileLock(first);
  assert.throws(
    () => assertActiveProfileLock(first),
    hasCode(X_FOR_YOU_ERROR_CODES.PROFILE_LOCK_INVALID),
  );
  const second = await acquireProfileLock({ lockFilePath, now: ACTIVE_TIME });
  await releaseProfileLock(second);
});

test("authorization issues an opaque capability bound to the live flag and account", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);

  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  assert.deepEqual(Object.keys(capability), []);
  const context = assertVerifiedCapability(capability);
  assert.equal(context.requestedPostLimit, 100);
  assert.equal(context.approvedAccount, "@signalfoundry");
  assert.match(context.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(context.startedAt, ACTIVE_TIME.toISOString());
  assert.equal(context.runtimePaths.runtimeDirectory, fixture.runtimeDirectory);
  assert.throws(
    () => assertVerifiedCapability({}),
    hasCode(X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED),
  );

  fixture.env.X_WEB_AUTOMATION_ENABLED = "false";
  assert.throws(
    () => assertVerifiedCapability(capability),
    hasCode(X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED),
  );
  fixture.env.X_WEB_AUTOMATION_ENABLED = "true";
  fixture.env.X_WEB_AUTOMATION_APPROVED_ACCOUNT = "@another_account";
  assert.throws(
    () => assertVerifiedCapability(capability),
    hasCode(X_FOR_YOU_ERROR_CODES.APPROVED_ACCOUNT_MISMATCH),
  );
  fixture.env.X_WEB_AUTOMATION_APPROVED_ACCOUNT = "@SignalFoundry";
  assert.equal(assertVerifiedCapability(capability).runId, context.runId);

  assert.equal(await releaseVerifiedCapability(capability), true);
  assert.equal(await releaseVerifiedCapability(capability), false);
  assert.throws(
    () => assertVerifiedCapability(capability),
    hasCode(X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED),
  );

  const nextCapability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  assert.notEqual(assertVerifiedCapability(nextCapability).runId, context.runId);
  await releaseVerifiedCapability(nextCapability);
});

test("a run capability has one browser-launch claim", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });

  assert.equal(
    claimVerifiedCapabilityForBrowserLaunch(capability, { now: ACTIVE_TIME })
      .configuredAccount,
    "@SignalFoundry",
  );
  assert.throws(
    () => claimVerifiedCapabilityForBrowserLaunch(capability, {
      now: ACTIVE_TIME,
    }),
    hasCode(X_FOR_YOU_ERROR_CODES.BROWSER_LAUNCH_ALREADY_CLAIMED),
  );
  await releaseVerifiedCapability(capability);
});

test("the actual process environment is clean immediately before browser import", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  let browserImports = 0;

  const canary = "credential-canary-must-not-leak";
  for (const name of [
    "DEBUG",
    "DEBUG_FILE",
    "PWDEBUG",
    "PWDEBUGIMPL",
    "PWTEST_UNSAFE",
    "PLAYWRIGHT_BROWSERS_PATH",
  ]) {
    const hadValue = Object.hasOwn(process.env, name);
    const previous = process.env[name];
    process.env[name] = canary;
    try {
      await assert.rejects(
        launchAuthorizedChrome(capability, {
          clock: () => ACTIVE_TIME,
          async loadChromium() {
            browserImports += 1;
            throw new Error("browser module must not load");
          },
        }),
        (error) => {
          assert.equal(
            hasCode(X_FOR_YOU_ERROR_CODES.CONFIG_INVALID)(error),
            true,
          );
          assert.equal(JSON.stringify(error).includes(canary), false);
          return true;
        },
      );
    } finally {
      if (hadValue) process.env[name] = previous;
      else delete process.env[name];
    }
  }

  assert.equal(browserImports, 0);
  await releaseVerifiedCapability(capability);
});

test("browser setup closes a launched context before the lock is released", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  let closes = 0;
  let launchProfile = null;
  let launchOptions = null;

  await assert.rejects(
    launchAuthorizedChrome(capability, {
      clock: () => ACTIVE_TIME,
      async loadChromium() {
        return {
          async launchPersistentContext(profileDirectory, options) {
            launchProfile = profileDirectory;
            launchOptions = options;
            return {
              setDefaultTimeout() {},
              setDefaultNavigationTimeout() {},
              pages: () => [],
              async newPage() {
                throw new Error("synthetic page setup failure");
              },
              async close() {
                closes += 1;
              },
            };
          },
        };
      },
    }),
    /synthetic page setup failure/,
  );
  assert.equal(closes, 1);
  assert.equal(launchProfile, join(fixture.runtimeDirectory, "chrome-profile"));
  assert.equal(launchOptions.chromiumSandbox, true);
  assert.equal(launchOptions.headless, false);
  assert.equal(launchOptions.channel, "chrome");
  await releaseVerifiedCapability(capability);
});

test("authorized browser setup applies deadlines and makes extra pages fatal", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  const primaryPage = Object.freeze({ async close() {} });
  let actionTimeout = null;
  let navigationTimeout = null;
  let pageListener = null;
  let contextCloses = 0;
  let launchOptions = null;
  const context = {
    setDefaultTimeout(value) {
      actionTimeout = value;
    },
    setDefaultNavigationTimeout(value) {
      navigationTimeout = value;
    },
    pages() {
      return [primaryPage];
    },
    on(event, handler) {
      assert.equal(event, "page");
      pageListener = handler;
    },
    async close() {
      contextCloses += 1;
    },
  };

  const launched = await launchAuthorizedChrome(capability, {
    clock: () => ACTIVE_TIME,
    async loadChromium() {
      return {
        async launchPersistentContext(_profileDirectory, options) {
          launchOptions = options;
          return context;
        },
      };
    },
  });

  assert.equal(actionTimeout, 30_000);
  assert.equal(navigationTimeout, 30_000);
  assert.equal(launchOptions.timeout, 30_000);
  assert.equal(launched.assertNoUnexpectedPages(), true);

  let extraPageCloses = 0;
  pageListener({
    async close() {
      extraPageCloses += 1;
    },
  });
  await Promise.resolve();
  assert.equal(extraPageCloses, 1);
  assert.throws(
    () => launched.assertNoUnexpectedPages(),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );

  await closeBrowserContext(launched.context);
  assert.equal(contextCloses, 1);
  await releaseVerifiedCapability(capability);
});

test("an extra page present at startup closes the context and aborts", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });
  const primaryPage = Object.freeze({ async close() {} });
  let extraCloses = 0;
  let contextCloses = 0;
  const extraPage = Object.freeze({
    async close() {
      extraCloses += 1;
    },
  });

  await assert.rejects(
    launchAuthorizedChrome(capability, {
      clock: () => ACTIVE_TIME,
      async loadChromium() {
        return {
          async launchPersistentContext() {
            return {
              setDefaultTimeout() {},
              setDefaultNavigationTimeout() {},
              pages: () => [primaryPage, extraPage],
              on() {},
              async close() {
                contextCloses += 1;
              },
            };
          },
        };
      },
    }),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );

  assert.equal(extraCloses, 1);
  assert.equal(contextCloses, 1);
  await releaseVerifiedCapability(capability);
});

test("a rejected Chrome launch fails closed because child shutdown is unknown", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });

  await assert.rejects(
    launchAuthorizedChrome(capability, {
      clock: () => ACTIVE_TIME,
      async loadChromium() {
        return {
          async launchPersistentContext() {
            throw new Error("synthetic launch rejection");
          },
        };
      },
    }),
    (error) => error?.code === "BROWSER_CLOSE_FAILED",
  );
  assert.equal(abandonVerifiedCapability(capability), true);
  await assert.rejects(
    authorizeCollectorRun({
      env: fixture.env,
      repositoryRoot: fixture.repositoryRoot,
      now: ACTIVE_TIME,
    }),
    hasCode(X_FOR_YOU_ERROR_CODES.PROFILE_LOCKED),
  );
});

test("an unconfirmed setup shutdown revokes capability and strands the profile lock", async (t) => {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const capability = await authorizeCollectorRun({
    env: fixture.env,
    repositoryRoot: fixture.repositoryRoot,
    now: ACTIVE_TIME,
  });

  await assert.rejects(
    launchAuthorizedChrome(capability, {
      clock: () => ACTIVE_TIME,
      async loadChromium() {
        return {
          async launchPersistentContext() {
            return {
              setDefaultTimeout() {},
              setDefaultNavigationTimeout() {},
              pages: () => [],
              async newPage() {
                throw new Error("synthetic page setup failure");
              },
              async close() {
                throw new Error("synthetic close failure");
              },
            };
          },
        };
      },
    }),
    (error) => error?.code === "BROWSER_CLOSE_FAILED",
  );

  assert.equal(abandonVerifiedCapability(capability), true);
  assert.throws(
    () => assertVerifiedCapability(capability, { now: ACTIVE_TIME }),
    hasCode(X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED),
  );
  await assert.rejects(
    authorizeCollectorRun({
      env: fixture.env,
      repositoryRoot: fixture.repositoryRoot,
      now: ACTIVE_TIME,
    }),
    hasCode(X_FOR_YOU_ERROR_CODES.PROFILE_LOCKED),
  );
});

test("browser shutdown has a bounded fail-closed timeout", async () => {
  await assert.rejects(
    closeBrowserContext(
      { close: () => new Promise(() => {}) },
      {
        timeoutMs: 1,
        setTimer(callback) {
          callback();
          return { unref() {} };
        },
        clearTimer() {},
      },
    ),
    (error) => error?.code === "BROWSER_CLOSE_FAILED",
  );
});

test("the authorization subsystem has no Playwright import", async () => {
  const sources = await Promise.all(
    ["preflight.js", "profile-lock.js"].map(
      (file) => readFile(
        new URL(`../src/lib/x/for-you/${file}`, import.meta.url),
        "utf8",
      ),
    ),
  );
  for (const source of sources) {
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*\()\s*["'](?:@playwright|playwright)/i,
    );
  }
});
