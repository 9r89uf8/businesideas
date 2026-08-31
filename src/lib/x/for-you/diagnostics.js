import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeErrorFields } from "./logging.js";
import { isAllowedXUrl, sanitizePageUrl } from "./navigation.js";

const SCREENSHOT_SAFE_FAILURES = new Set([
  "FEED_ERROR",
  "NAVIGATION_BLOCKED",
  "SELECTOR_DRIFT",
]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRUCTURE_TAGS = new Set([
  "a",
  "article",
  "button",
  "div",
  "form",
  "h1",
  "h2",
  "header",
  "iframe",
  "img",
  "input",
  "label",
  "main",
  "nav",
  "p",
  "section",
  "span",
  "time",
  "video",
]);

function sanitizePageTitle(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (/^(?:\(\d+\)\s*)?Home(?: \/ X)?$/i.test(normalized)) {
    return "Home / X";
  }
  if (/^X$/i.test(normalized)) return "X";
  return "[redacted]";
}

function sanitizeStructureResult(value) {
  if (typeof value !== "string" || value.length > 8_192) return null;
  const lines = value ? value.split("\n") : [];
  if (lines.length > 200) return null;

  for (const line of lines) {
    const match = line.match(/^ {0,12}<([a-z][a-z0-9-]{0,30})((?: [a-z-]+="[A-Za-z0-9_-]+")*)>$/);
    if (!match || !STRUCTURE_TAGS.has(match[1])) return null;
    const seen = new Set();
    for (const attribute of match[2].trim().split(/\s+/).filter(Boolean)) {
      const parsed = attribute.match(/^([a-z-]+)="([A-Za-z0-9_-]+)"$/);
      if (!parsed || seen.has(parsed[1])) return null;
      seen.add(parsed[1]);
      if (parsed[1] === "aria-selected" && !["true", "false"].includes(parsed[2])) {
        return null;
      }
      if (
        parsed[1] === "role" &&
        ![
          "alert",
          "button",
          "dialog",
          "form",
          "main",
          "navigation",
          "tab",
          "tablist",
          "textbox",
        ].includes(parsed[2])
      ) {
        return null;
      }
      if (
        parsed[1] === "data-testid" &&
        ![
          "AppTabBar_Home_Link",
          "AppTabBar_Profile_Link",
          "LoginForm_Login_Button",
          "SideNav_AccountSwitcher_Button",
          "User-Name",
          "emptyState",
          "error-detail",
          "primaryColumn",
          "socialContext",
          "tweet",
          "tweetPhoto",
          "tweetText",
        ].includes(parsed[2])
      ) {
        return null;
      }
      if (!["aria-selected", "role", "data-testid"].includes(parsed[1])) {
        return null;
      }
    }
  }
  return lines.join("\n");
}

/**
 * Runs in the page and returns structure only: no text, URLs, form values,
 * styles, or arbitrary attributes. Attribute values come from fixed
 * allowlists, so timeline/account content cannot enter the diagnostic JSON.
 */
export function sanitizedStructureFromElement(root) {
  const allowedTestIds = new Set([
    "AppTabBar_Home_Link",
    "AppTabBar_Profile_Link",
    "LoginForm_Login_Button",
    "SideNav_AccountSwitcher_Button",
    "User-Name",
    "emptyState",
    "error-detail",
    "primaryColumn",
    "socialContext",
    "tweet",
    "tweetPhoto",
    "tweetText",
  ]);
  const allowedRoles = new Set([
    "alert",
    "button",
    "dialog",
    "form",
    "main",
    "navigation",
    "tab",
    "tablist",
    "textbox",
  ]);
  const lines = [];
  const queue = [{ node: root, depth: 0 }];

  while (queue.length > 0 && lines.length < 200) {
    const { node, depth } = queue.shift();
    if (!node || depth > 6) continue;
    const tagName = String(node.tagName || "").toLowerCase();
    const children = depth < 6 ? Array.from(node.children || []) : [];
    if (![
      "a", "article", "button", "div", "form", "h1", "h2", "header",
      "iframe", "img", "input", "label", "main", "nav", "p", "section",
      "span", "time", "video",
    ].includes(tagName)) {
      for (const child of children) queue.push({ node: child, depth });
      continue;
    }

    const attributes = [];
    const role = node.getAttribute?.("role");
    const testId = node.getAttribute?.("data-testid");
    const ariaSelected = node.getAttribute?.("aria-selected");
    if (allowedRoles.has(role)) attributes.push(`role="${role}"`);
    if (allowedTestIds.has(testId)) {
      attributes.push(`data-testid="${testId}"`);
    }
    if (ariaSelected === "true" || ariaSelected === "false") {
      attributes.push(`aria-selected="${ariaSelected}"`);
    }
    lines.push(`${"  ".repeat(depth)}<${tagName}${
      attributes.length ? ` ${attributes.join(" ")}` : ""
    }>`);

    if (depth < 6) {
      for (const child of children) {
        queue.push({ node: child, depth: depth + 1 });
      }
    }
  }

  return lines.join("\n").slice(0, 8_192);
}

function isHomeUrl(value) {
  try {
    return (
      isAllowedXUrl(value) && /^\/home\/?$/.test(new URL(value).pathname)
    );
  } catch {
    return false;
  }
}

export async function saveFailureDiagnostics({
  page,
  outputDirectory,
  runId,
  error,
  postsCollected,
  saveScreenshot = true,
  assertPermissionActive = () => {},
}) {
  if (!page || page.isClosed()) return Object.freeze({});
  if (!RUN_ID_PATTERN.test(runId || "")) {
    throw new TypeError("A valid run ID is required for collector diagnostics.");
  }
  const safePostsCollected =
    Number.isSafeInteger(postsCollected) &&
    postsCollected >= 0 &&
    postsCollected <= 100
      ? postsCollected
      : 0;
  assertPermissionActive();
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });

  const diagnosticFileName = `${runId}.failure.json`;
  const diagnosticPath = path.join(outputDirectory, diagnosticFileName);
  const safeError = safeErrorFields(error);
  let pageTitle = null;
  let sanitizedHtmlFragment = null;

  if (isHomeUrl(page.url())) {
    assertPermissionActive();
    try {
      pageTitle = sanitizePageTitle(await page.title());
    } catch {
      pageTitle = null;
    }
    assertPermissionActive();
    if (!isHomeUrl(page.url())) pageTitle = null;

    if (isHomeUrl(page.url())) {
      try {
        const main = page.locator("main").first();
        sanitizedHtmlFragment = sanitizeStructureResult(
          await main.evaluate(sanitizedStructureFromElement),
        );
      } catch {
        sanitizedHtmlFragment = null;
      }
      assertPermissionActive();
      if (!isHomeUrl(page.url())) sanitizedHtmlFragment = null;
    }
  }

  await writeFile(
    diagnosticPath,
    `${JSON.stringify({
      runId,
      capturedAt: new Date().toISOString(),
      currentUrl: sanitizePageUrl(page.url()),
      pageTitle,
      failureCategory: safeError.errorCode,
      failedLocator: safeError.locator || null,
      postsCollected: safePostsCollected,
      sanitizedHtmlFragment,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );

  let screenshotFileName = null;
  if (
    saveScreenshot &&
    SCREENSHOT_SAFE_FAILURES.has(safeError.errorCode) &&
    isHomeUrl(page.url())
  ) {
    screenshotFileName = `${runId}.failure.png`;
    assertPermissionActive();
    try {
      await page.screenshot({
        path: path.join(outputDirectory, screenshotFileName),
        fullPage: false,
        animations: "disabled",
        mask: [
          page.locator("input"),
          page.locator('[data-testid="SideNav_AccountSwitcher_Button"]'),
          page.locator('[role="dialog"]'),
          page.locator('[data-testid="DMDrawer"]'),
        ],
      });
    } catch {
      screenshotFileName = null;
    }
    assertPermissionActive();
  }

  return Object.freeze({ diagnosticFileName, screenshotFileName });
}
