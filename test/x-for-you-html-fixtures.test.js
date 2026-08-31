import assert from "node:assert/strict";
import test from "node:test";

import { assertForYouSelected } from "../src/lib/x/for-you/feed.js";
import { requireAuthenticatedAccount } from "../src/lib/x/for-you/login.js";
import {
  detectXPageState,
  feedHasVisibleError,
  X_PAGE_STATES,
} from "../src/lib/x/for-you/page-state.js";
import { loadXHtmlFixturePage } from "./support/x-html-fixture-page.js";

test("literal login fixtures exercise each bounded authentication state", async () => {
  const fixtures = [
    ["logged-out.html", X_PAGE_STATES.LOGIN_REQUIRED],
    ["username-confirmation.html", X_PAGE_STATES.USERNAME_REQUIRED],
    ["password.html", X_PAGE_STATES.PASSWORD_REQUIRED],
    ["challenge.html", X_PAGE_STATES.CHALLENGE],
  ];

  for (const [fileName, expectedState] of fixtures) {
    const page = await loadXHtmlFixturePage(
      fileName,
      "https://x.com/i/flow/login",
    );
    assert.equal(await detectXPageState(page), expectedState, fileName);
  }
});

test("literal Home fixture verifies authenticated account and selected For You", async () => {
  const page = await loadXHtmlFixturePage(
    "for-you-feed.html",
    "https://x.com/home",
  );

  assert.equal(await detectXPageState(page), X_PAGE_STATES.AUTHENTICATED);
  assert.equal(
    await requireAuthenticatedAccount(page, "@collector_acct"),
    "@Collector_Acct",
  );
  assert.equal(await assertForYouSelected(page), true);
  assert.equal(await feedHasVisibleError(page), false);
});

test("timeline prose cannot impersonate challenge or feed-error UI", async () => {
  const page = await loadXHtmlFixturePage(
    "timeline-misleading-system-copy.html",
    "https://x.com/home",
  );

  assert.equal(await detectXPageState(page), X_PAGE_STATES.AUTHENTICATED);
  assert.equal(await feedHasVisibleError(page), false);
});

test("system feed errors are detected only outside timeline articles", async () => {
  const page = await loadXHtmlFixturePage(
    "system-feed-error.html",
    "https://x.com/home",
  );

  assert.equal(await detectXPageState(page), X_PAGE_STATES.AUTHENTICATED);
  assert.equal(await feedHasVisibleError(page), true);
});

test("deceptive account-switcher text cannot override the profile href", async () => {
  const page = await loadXHtmlFixturePage(
    "deceptive-account.html",
    "https://x.com/home",
  );

  await assert.rejects(
    requireAuthenticatedAccount(page, "@ExpectedAcct"),
    (error) =>
      error?.code === "AUTH_ACCOUNT_MISMATCH" &&
      !error.message.includes("ExpectedAcct") &&
      !error.message.includes("ActualAcct"),
  );
});
