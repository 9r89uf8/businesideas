import assert from "node:assert/strict";
import { test } from "node:test";

import { assertForYouSelected } from "../src/lib/x/for-you/feed.js";
import { requireAuthenticatedAccount } from "../src/lib/x/for-you/login.js";
import { X_LOCATORS } from "../src/lib/x/for-you/locators.js";
import { requireXHomePage } from "../src/lib/x/for-you/navigation.js";

class SyntheticLocator {
  constructor({ attributes = {}, text = "", visible = false } = {}) {
    this.attributes = attributes;
    this.text = text;
    this.visible = visible;
  }

  first() {
    return this;
  }

  async isVisible() {
    return this.visible;
  }

  async innerText() {
    return this.text;
  }

  async getAttribute(name) {
    return this.attributes[name] ?? null;
  }
}

class SyntheticAuthenticatedPage {
  constructor({
    accountText = null,
    forYouSelected = true,
    forYouVisible = true,
    profileHref = null,
    url = "https://x.com/home",
  } = {}) {
    this.accountText = accountText;
    this.forYouSelected = forYouSelected;
    this.forYouVisible = forYouVisible;
    this.profileHref = profileHref;
    this.currentUrl = url;
  }

  url() {
    return this.currentUrl;
  }

  getByRole(role, { name }) {
    const matchesForYou =
      role === "tab" &&
      (name instanceof RegExp ? name.test("For you") : name === "For you");
    return new SyntheticLocator({
      attributes: {
        "aria-selected": this.forYouSelected ? "true" : "false",
      },
      visible: matchesForYou && this.forYouVisible,
    });
  }

  getByText() {
    return new SyntheticLocator();
  }

  locator(selector) {
    if (selector === '[data-testid="SideNav_AccountSwitcher_Button"]') {
      return new SyntheticLocator({
        text: this.accountText ?? "",
        visible: this.accountText !== null,
      });
    }
    if (selector === 'a[data-testid="AppTabBar_Profile_Link"][href]') {
      return new SyntheticLocator({
        attributes: { href: this.profileHref },
        visible: this.profileHref !== null,
      });
    }
    return new SyntheticLocator();
  }

  async waitForTimeout() {}
}

function assertSafeAccountError(error, { code, forbiddenHandles }) {
  assert.equal(error?.code, code);
  const exposed = `${error?.message ?? ""} ${JSON.stringify(error)}`.toLowerCase();
  for (const handle of forbiddenHandles) {
    assert.equal(exposed.includes(handle.replace(/^@/, "").toLowerCase()), false);
  }
  return true;
}

test("authenticated account binding matches handles case-insensitively", async () => {
  assert.deepEqual(X_LOCATORS.authenticatedAccount, [
    {
      kind: "css",
      selector: 'a[data-testid="AppTabBar_Profile_Link"][href]',
    },
  ]);
  const profileLinkPage = new SyntheticAuthenticatedPage({
    profileHref: "/Collector_Acct",
  });
  assert.equal(
    await requireAuthenticatedAccount(profileLinkPage, "@COLLECTOR_ACCT"),
    "@Collector_Acct",
  );
});

test("authenticated account binding waits for the exact profile link", async () => {
  const page = new SyntheticAuthenticatedPage();
  page.waitForTimeout = async () => {
    page.profileHref = "/Collector_Acct";
  };

  assert.equal(
    await requireAuthenticatedAccount(page, "@collector_acct", {
      timeoutMs: 1_000,
    }),
    "@Collector_Acct",
  );
});

test("missing or mismatched authenticated accounts fail without handle disclosure", async () => {
  const expected = "@ExpectedAcct";
  await assert.rejects(
    requireAuthenticatedAccount(new SyntheticAuthenticatedPage(), expected),
    (error) => assertSafeAccountError(error, {
      code: "AUTH_ACCOUNT_UNVERIFIED",
      forbiddenHandles: [expected],
    }),
  );

  const actual = "@ActualAcct";
  const mismatchedPage = new SyntheticAuthenticatedPage({
    // Unstructured display text is deliberately deceptive; the exact profile
    // href is the sole account-identity proof.
    accountText: expected,
    profileHref: "/ActualAcct",
  });
  await assert.rejects(
    requireAuthenticatedAccount(mismatchedPage, expected),
    (error) => assertSafeAccountError(error, {
      code: "AUTH_ACCOUNT_MISMATCH",
      forbiddenHandles: [expected, actual],
    }),
  );

  for (const untrustedPage of [
    new SyntheticAuthenticatedPage({
      profileHref: "https://attacker.example/ExpectedAcct",
    }),
    new SyntheticAuthenticatedPage({
      profileHref: "https://x.com:444/ExpectedAcct",
    }),
    new SyntheticAuthenticatedPage({
      profileHref: "https://attacker@x.com/ExpectedAcct",
    }),
    new SyntheticAuthenticatedPage({
      profileHref: "/ExpectedAcct/status/123",
    }),
    new SyntheticAuthenticatedPage({
      accountText: "user@ExpectedAcct",
    }),
    new SyntheticAuthenticatedPage({
      accountText: expected,
    }),
  ]) {
    await assert.rejects(
      requireAuthenticatedAccount(untrustedPage, expected),
      (error) => assertSafeAccountError(error, {
        code: "AUTH_ACCOUNT_UNVERIFIED",
        forbiddenHandles: [expected],
      }),
    );
  }
});

test("the Home phase accepts only the exact X Home path", () => {
  for (const url of [
    "https://x.com/home",
    "https://www.x.com/home/",
    "https://twitter.com/home?source=synthetic#top",
  ]) {
    const page = new SyntheticAuthenticatedPage({ url });
    assert.equal(requireXHomePage(page), url);
  }

  for (const url of [
    "https://x.com/",
    "https://x.com/Home",
    "https://x.com/home/timeline",
    "https://x.com/messages",
    "https://x.com/settings/account",
    "https://x.com/i/flow/login",
    "https://attacker.example/home",
  ]) {
    assert.throws(
      () => requireXHomePage(new SyntheticAuthenticatedPage({ url })),
      (error) => error?.code === "NAVIGATION_BLOCKED",
      url,
    );
  }
});

test("For You phase assertion fails closed when selected state drifts", async () => {
  const page = new SyntheticAuthenticatedPage({ forYouSelected: true });
  assert.equal(await assertForYouSelected(page), true);

  page.forYouSelected = false;
  await assert.rejects(
    assertForYouSelected(page),
    (error) =>
      error?.code === "SELECTOR_DRIFT" &&
      error?.locator === "for-you-tab[aria-selected=true]",
  );

  page.forYouSelected = true;
  page.currentUrl = "https://x.com/messages";
  await assert.rejects(
    assertForYouSelected(page),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
});
