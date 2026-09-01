import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  AUTHORIZED_CHROME_OPTIONS,
  buildAuthorizedBrowserEnvironment,
  launchAuthorizedChrome,
} from "../src/lib/x/for-you/browser.js";
import {
  COLLECTOR_COMMAND_MODES,
  executeCollectorCommand,
  parseCollectorArguments,
} from "../src/lib/x/for-you/command.js";
import { X_FOR_YOU_ERROR_CODES } from "../src/lib/x/for-you/errors.js";
import {
  assertSafeBrowserEnvironment,
  resolvePreflightConfig,
} from "../src/lib/x/for-you/preflight.js";
import { resolveCollectorRuntimeOptions } from "../src/lib/x/for-you/runtime-options.js";

test("collector CLI accepts only check, collect, and help modes", () => {
  assert.equal(parseCollectorArguments([]), COLLECTOR_COMMAND_MODES.COLLECT);
  assert.equal(
    parseCollectorArguments(["--check"]),
    COLLECTOR_COMMAND_MODES.CHECK,
  );
  assert.equal(parseCollectorArguments(["--help"]), "help");
  assert.throws(() => parseCollectorArguments(["--limit", "10"]));
});

test("a disabled permission gate never loads the browser runner", async () => {
  let runnerLoads = 0;
  const events = [];
  const result = await executeCollectorCommand({
    mode: COLLECTOR_COMMAND_MODES.COLLECT,
    env: {},
    repositoryRoot: resolve("."),
    log(event, fields) {
      events.push({ event, fields });
    },
    async loadRunner() {
      runnerLoads += 1;
      throw new Error("browser runner must not load");
    },
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.errorCode, X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED);
  assert.equal(runnerLoads, 0);
  assert.deepEqual(events, [
    {
      event: "PERMISSION_DENIED",
      fields: { errorCode: X_FOR_YOU_ERROR_CODES.FEATURE_DISABLED },
    },
  ]);
});

test("a forged capability fails before Playwright can be dynamically imported", async () => {
  await assert.rejects(
    launchAuthorizedChrome({}),
    (error) => error?.code === X_FOR_YOU_ERROR_CODES.VERIFIED_CAPABILITY_REQUIRED,
  );
});

test("the entry graph keeps Playwright behind both runtime capability checks", async () => {
  const [entrySource, commandSource, browserSource] = await Promise.all([
    readFile(new URL("../scripts/collect-x-for-you.js", import.meta.url), "utf8"),
    readFile(
      new URL("../src/lib/x/for-you/command.js", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/lib/x/for-you/browser.js", import.meta.url),
      "utf8",
    ),
  ]);

  assert.doesNotMatch(entrySource, /playwright|runner\.js|browser\.js/i);
  assert.doesNotMatch(commandSource, /^import .*runner\.js/m);
  assert.match(commandSource, /import\("\.\/runner\.js"\)/);
  assert.doesNotMatch(browserSource, /^import .*playwright-core/m);

  assert.match(browserSource, /await import\("playwright-core"\)/);
  const firstCheck = browserSource.indexOf(
    "const authorized = assertVerifiedCapability",
  );
  const loaderCall = browserSource.indexOf("const chromium = await loadChromium()");
  const preImportRecheck = browserSource.lastIndexOf(
    "assertVerifiedCapability(capability",
    loaderCall,
  );
  const preImportEnvironmentCheck = browserSource.lastIndexOf(
    "assertSafeBrowserEnvironment(process.env)",
    loaderCall,
  );
  const launchClaim = browserSource.indexOf(
    "claimVerifiedCapabilityForBrowserLaunch",
    loaderCall,
  );
  const browserLaunch = browserSource.indexOf("chromium.launchPersistentContext");
  assert.ok(firstCheck >= 0 && firstCheck < loaderCall);
  assert.ok(preImportRecheck > browserSource.indexOf("await mkdir"));
  assert.ok(preImportRecheck < loaderCall);
  assert.ok(preImportEnvironmentCheck > preImportRecheck);
  assert.ok(preImportEnvironmentCheck < loaderCall);
  assert.ok(loaderCall < launchClaim && launchClaim < browserLaunch);
  assert.deepEqual(AUTHORIZED_CHROME_OPTIONS, {
    channel: "chrome",
    headless: false,
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    chromiumSandbox: true,
    serviceWorkers: "block",
    timeout: 30_000,
  });
});

test("preflight and runtime controls reject values beyond hard bounds", () => {
  const externalRoot = join(tmpdir(), "tx1000-x-command-contract");
  assert.throws(
    () => resolvePreflightConfig({
      repositoryRoot: resolve("."),
      env: {
        X_WEB_AUTOMATION_ENABLED: "true",
        X_LOGIN_USERNAME: "@account",
        X_WEB_AUTOMATION_APPROVED_ACCOUNT: "@account",
        X_WEB_AUTOMATION_POST_LIMIT: "101",
        X_WEB_AUTOMATION_RUNTIME_DIR: join(externalRoot, "runtime"),
      },
    }),
    (error) => error?.code === X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
  );
  assert.throws(
    () => resolveCollectorRuntimeOptions({
      X_WEB_AUTOMATION_MAX_RUNTIME_MS: "900001",
    }),
    /maximum runtime/i,
  );
  assert.throws(
    () => resolveCollectorRuntimeOptions({
      X_WEB_AUTOMATION_INTERACTIVE_CHALLENGES: "TRUE",
    }),
    /exactly true or false/i,
  );
});

test("preflight rejects ambient browser debug and instrumentation controls", () => {
  assert.equal(assertSafeBrowserEnvironment({ PWD: "ordinary-shell-path" }), true);

  for (const name of [
    "DEBUG",
    "DEBUG_FILE",
    "PWDEBUG",
    "PWDEBUGIMPL",
    "PWTEST_UNSAFE",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PLAYWRIGHT_SKIP_NAVIGATION_CHECK",
    "npm_config_pwdebug",
    "npm_package_config_pwdebug",
  ]) {
    assert.throws(
      () => assertSafeBrowserEnvironment({ [name]: "enabled" }),
      (error) => error?.code === X_FOR_YOU_ERROR_CODES.CONFIG_INVALID,
      name,
    );
  }
});

test("Chrome receives only a minimal OS environment, never application secrets", () => {
  const browserEnvironment = buildAuthorizedBrowserEnvironment({
    SystemRoot: "C:\\Windows",
    PATH: "C:\\Windows\\System32",
    TEMP: "C:\\Temp",
    X_LOGIN_EMAIL: "secret-email",
    X_LOGIN_PASSWORD: "secret-password",
    x_password: "secret-lowercase-password",
    OPENAI_API_KEY: "secret-openai-key",
    SUPABASE_SECRET_KEY: "secret-supabase-key",
    X_BEARER_TOKEN: "secret-x-bearer",
    CRON_SECRET: "secret-cron",
    NODE_OPTIONS: "--inspect",
    DEBUG: "pw:api",
    DEBUG_FILE: "C:\\Temp\\playwright-debug.log",
    PWDEBUG: "1",
    PLAYWRIGHT_BROWSERS_PATH: "C:\\untrusted-browsers",
  });

  assert.deepEqual(browserEnvironment, {
    PATH: "C:\\Windows\\System32",
    SYSTEMROOT: "C:\\Windows",
    TEMP: "C:\\Temp",
  });
  const serialized = JSON.stringify(browserEnvironment);
  assert.doesNotMatch(serialized, /secret|password|token|inspect/i);
  assert.equal(Object.hasOwn(browserEnvironment, "DEBUG"), false);
  assert.equal(Object.hasOwn(browserEnvironment, "DEBUG_FILE"), false);
  assert.equal(Object.hasOwn(browserEnvironment, "PWDEBUG"), false);
  assert.equal(
    Object.hasOwn(browserEnvironment, "PLAYWRIGHT_BROWSERS_PATH"),
    false,
  );
});
