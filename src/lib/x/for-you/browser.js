import { mkdir } from "node:fs/promises";

import {
  browserCloseError,
  closeBrowserContext,
} from "./browser-close.js";
import {
  assertSafeBrowserEnvironment,
  assertVerifiedCapability,
  claimVerifiedCapabilityForBrowserLaunch,
} from "./preflight.js";

export const AUTHORIZED_CHROME_OPTIONS = Object.freeze({
  channel: "chrome",
  headless: false,
  locale: "en-US",
  viewport: Object.freeze({ width: 1280, height: 900 }),
  acceptDownloads: false,
  chromiumSandbox: true,
  serviceWorkers: "block",
  timeout: 30_000,
});

const BROWSER_ACTION_TIMEOUT_MS = 30_000;
const SAFE_BROWSER_ENVIRONMENT_KEYS = Object.freeze([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SESSIONNAME",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]);

export function buildAuthorizedBrowserEnvironment(env = process.env) {
  const normalized = new Map(
    Object.entries(env || {}).map(([name, value]) => [
      name.toUpperCase(),
      value,
    ]),
  );
  const result = {};
  for (const name of SAFE_BROWSER_ENVIRONMENT_KEYS) {
    const value = normalized.get(name);
    if (typeof value === "string" && !value.includes("\0")) {
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

function navigationBlockedError() {
  const error = new Error("An unexpected browser page was blocked.");
  error.code = "NAVIGATION_BLOCKED";
  return error;
}

export async function launchAuthorizedChrome(
  capability,
  {
    clock = () => new Date(),
    loadChromium = async () => (await import("playwright-core")).chromium,
  } = {},
) {
  const authorized = assertVerifiedCapability(capability, { now: clock() });
  await mkdir(authorized.runtimePaths.profileDirectory, {
    recursive: true,
    mode: 0o700,
  });

  // This is deliberately dynamic. The enabled flag, approved-account match,
  // and active profile lock all pass before Playwright/Chromium is imported.
  assertVerifiedCapability(capability, { now: clock() });
  assertSafeBrowserEnvironment(process.env);
  const chromium = await loadChromium();
  assertSafeBrowserEnvironment(process.env);
  const launchAuthorized = claimVerifiedCapabilityForBrowserLaunch(
    capability,
    { now: clock() },
  );
  let context = null;
  let launchAttempted = false;

  try {
    launchAttempted = true;
    const launchOptions = Object.freeze({
      ...AUTHORIZED_CHROME_OPTIONS,
      env: buildAuthorizedBrowserEnvironment(process.env),
    });
    context = await chromium.launchPersistentContext(
      launchAuthorized.runtimePaths.profileDirectory,
      launchOptions,
    );
    context.setDefaultTimeout(BROWSER_ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(BROWSER_ACTION_TIMEOUT_MS);

    let page = context.pages()[0];
    if (!page) page = await context.newPage();

    let unexpectedPageError = null;
    context.on("page", (openedPage) => {
      if (openedPage === page) return;
      unexpectedPageError ||= navigationBlockedError();
      void openedPage.close().catch(() => {
        unexpectedPageError ||= navigationBlockedError();
      });
    });

    for (const extraPage of context.pages()) {
      if (extraPage !== page) {
        unexpectedPageError ||= navigationBlockedError();
        await extraPage.close();
      }
    }
    if (unexpectedPageError) throw unexpectedPageError;

    return Object.freeze({
      context,
      page,
      assertNoUnexpectedPages() {
        if (unexpectedPageError) throw unexpectedPageError;
        return true;
      },
    });
  } catch (error) {
    if (context) {
      await closeBrowserContext(context);
    } else if (launchAttempted) {
      // A rejected launch promise cannot prove that no Chrome child survived.
      // Preserve the profile lock until an operator verifies process state.
      throw browserCloseError();
    }
    throw error;
  }
}
