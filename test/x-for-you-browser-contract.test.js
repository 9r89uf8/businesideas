import assert from "node:assert/strict";
import { test } from "node:test";

import {
  performReadOnlyAction,
  X_READ_ONLY_ACTIONS,
} from "../src/lib/x/for-you/action-policy.js";
import { selectForYouFeed } from "../src/lib/x/for-you/feed.js";
import {
  findVisibleLocator,
  locatorFromSpec,
  X_LOCATORS,
} from "../src/lib/x/for-you/locators.js";
import {
  ensureXAuthenticated,
  resolveXLoginCredentials,
} from "../src/lib/x/for-you/login.js";
import {
  installNavigationGuard,
  isAllowedXCombinedLoginUrl,
  isAllowedXLoginUrl,
  isAllowedXWorkflowUrl,
  isAllowedXUrl,
  requireAllowedXPage,
  sanitizePageUrl,
} from "../src/lib/x/for-you/navigation.js";
import {
  detectXPageState,
  X_PAGE_STATES,
} from "../src/lib/x/for-you/page-state.js";

function nameMatches(name, candidate) {
  if (name instanceof RegExp) {
    name.lastIndex = 0;
    return name.test(candidate);
  }

  return name === candidate;
}

function isForYou(spec) {
  return (
    (spec.kind === "role" &&
      spec.role === "tab" &&
      nameMatches(spec.name, "For you")) ||
    (spec.kind === "text" && nameMatches(spec.name, "For you"))
  );
}

function isLoginIdentifier(spec) {
  return (
    (spec.kind === "role" &&
      spec.role === "textbox" &&
      nameMatches(spec.name, "Phone, email, or username")) ||
    (spec.kind === "css" &&
      [
        'input[autocomplete="username"]',
        'input[name="text"]',
      ].includes(spec.selector))
  );
}

function isCombinedLoginIdentifier(spec) {
  return (
    spec.kind === "css" &&
    spec.selector === 'input[name="username_or_email"][type="text"]'
  );
}

function isCombinedLoginForm(spec) {
  return (
    spec.kind === "css" &&
    spec.selector ===
      'form:has(input[name="username_or_email"][type="text"]):has(input[name="password"][type="password"])'
  );
}

function isCombinedLoginIdentifierForm(spec) {
  return (
    spec.kind === "css" &&
    spec.selector ===
      'form:has(input[name="username_or_email"][type="text"])'
  );
}

function isCombinedLoginPasswordForm(spec) {
  return (
    spec.kind === "css" &&
    spec.selector === 'form:has(input[name="password"][type="password"])'
  );
}

function isCombinedLoginPassword(spec) {
  return (
    spec.kind === "css" &&
    spec.selector === 'input[name="password"][type="password"]'
  );
}

function isLoginNext(spec) {
  return (
    (spec.kind === "role" &&
      spec.role === "button" &&
      nameMatches(spec.name, "Next")) ||
    (spec.kind === "text" && nameMatches(spec.name, "Next"))
  );
}

function isUsernamePrompt(spec) {
  return (
    spec.kind === "text" &&
    nameMatches(spec.name, "Enter your phone number or username")
  );
}

function isPassword(spec) {
  return (
    (spec.kind === "role" &&
      spec.role === "textbox" &&
      nameMatches(spec.name, "Password")) ||
    (spec.kind === "css" &&
      ['input[name="password"]', 'input[type="password"]'].includes(
        spec.selector,
      ))
  );
}

function isLoginSubmit(spec) {
  return (
    (spec.kind === "role" &&
      spec.role === "button" &&
      nameMatches(spec.name, "Log in")) ||
    (spec.kind === "css" &&
      spec.selector === '[data-testid="LoginForm_Login_Button"]')
  );
}

function isCombinedLoginContinue(spec) {
  return (
    spec.kind === "role" &&
    spec.role === "button" &&
    nameMatches(spec.name, "Continue")
  );
}

function isLoginUsePassword(spec) {
  return (
    spec.kind === "role" &&
    spec.role === "button" &&
    nameMatches(spec.name, "Use password")
  );
}

function isCombinedLoginSubmit(spec) {
  return (
    spec.kind === "role" &&
    spec.role === "button" &&
    (nameMatches(spec.name, "Log in") || nameMatches(spec.name, "Continue"))
  );
}

function isOneTimeCode(spec) {
  return (
    spec.kind === "css" &&
    spec.selector === 'input[autocomplete="one-time-code"]'
  );
}

function isChallenge(spec) {
  return (
    (spec.kind === "css" && spec.selector === 'iframe[src*="captcha"]') ||
    (spec.kind === "text" && nameMatches(spec.name, "Verify your identity"))
  );
}

class FakeLocator {
  constructor(page, spec) {
    this.page = page;
    this.spec = spec;
  }

  first() {
    return this;
  }

  async isVisible() {
    return this.page.isVisible(this.spec);
  }

  async fill(value) {
    this.page.actions.push({
      type: "fill",
      spec: this.spec,
      value,
      url: this.page.url(),
      combinedPhase: this.page.combinedPhase,
    });
    this.page.afterFill(this.spec);
  }

  async click() {
    this.page.actions.push({
      type: "click",
      spec: this.spec,
      url: this.page.url(),
      combinedPhase: this.page.combinedPhase,
    });
    this.page.afterClick(this.spec);
  }

  async getAttribute(name) {
    this.page.attributeReads.push({ name, spec: this.spec });
    if (name === "aria-selected" && isForYou(this.spec)) {
      return this.page.forYouSelected ? "true" : "false";
    }
    return null;
  }


  getByRole(role, { name }) {
    return new FakeLocator(this.page, { kind: "role", role, name });
  }

  getByText(name, { exact }) {
    return new FakeLocator(this.page, { kind: "text", name, exact });
  }

  locator(selector) {
    return new FakeLocator(this.page, { kind: "css", selector });
  }
}

class FakePage {
  constructor({
    state = X_PAGE_STATES.UNKNOWN,
    url = "https://x.com/home",
    nextStates = [],
    submitState = X_PAGE_STATES.AUTHENTICATED,
    forYouSelected = false,
    selectForYouOnClick = true,
    navigateExternallyOnNext = false,
    genericLoginControlsOnHome = false,
    redirectHomeToRoot = false,
    combinedLoginRoute = false,
    rootLandingUrl = "https://x.com/",
    homeSettlesToBareRoot = false,
    loginSettlesToCombined = false,
    loginStaysOnRoot = false,
    combinedUsePasswordVisible = true,
    combinedUsePasswordClickTransitions = true,
    combinedUsePasswordDelayWaits = 0,
    combinedUsePasswordNavigateOnWait = null,
    combinedSubmitDelayWaits = 0,
    combinedSubmitNavigateOnWait = null,
  } = {}) {
    this.state = state;
    this.currentUrl = url;
    this.nextStates = [...nextStates];
    this.submitState = submitState;
    this.forYouSelected = forYouSelected;
    this.selectForYouOnClick = selectForYouOnClick;
    this.navigateExternallyOnNext = navigateExternallyOnNext;
    this.genericLoginControlsOnHome = genericLoginControlsOnHome;
    this.redirectHomeToRoot = redirectHomeToRoot;
    this.combinedLoginRoute = combinedLoginRoute;
    this.rootLandingUrl = rootLandingUrl;
    this.homeSettlesToBareRoot = homeSettlesToBareRoot;
    this.loginSettlesToCombined = loginSettlesToCombined;
    this.loginStaysOnRoot = loginStaysOnRoot;
    this.combinedUsePasswordVisible = combinedUsePasswordVisible;
    this.combinedUsePasswordClickTransitions =
      combinedUsePasswordClickTransitions;
    this.combinedUsePasswordDelayWaits = combinedUsePasswordDelayWaits;
    this.combinedUsePasswordNavigateOnWait =
      combinedUsePasswordNavigateOnWait;
    this.combinedUsePasswordWaits = 0;
    this.combinedSubmitDelayWaits = combinedSubmitDelayWaits;
    this.combinedSubmitNavigateOnWait = combinedSubmitNavigateOnWait;
    this.combinedSubmitWaits = 0;
    this.pendingHomeTransition = false;
    this.pendingLoginTransition = false;
    this.combinedIdentifierFilled = false;
    this.combinedPasswordFilled = false;
    this.combinedPhase = state === X_PAGE_STATES.USE_PASSWORD_REQUIRED
      ? "use-password"
      : state === X_PAGE_STATES.COMBINED_LOGIN_REQUIRED
        ? "identifier"
        : null;
    this.actions = [];
    this.attributeReads = [];
    this.gotoCalls = [];
    this.waitCalls = [];
    this.routeHandler = null;
    this.listeners = new Map();
    this.frame = Object.freeze({
      kind: "main-frame",
      page: () => this,
    });
  }

  url() {
    return this.currentUrl;
  }

  async goto(url, options) {
    if (this.state === X_PAGE_STATES.AUTHENTICATED) {
      this.currentUrl = url;
    } else if (this.state === X_PAGE_STATES.CHALLENGE) {
      this.currentUrl = "https://x.com/i/flow/challenge";
    } else if (url === "https://x.com/home" && this.redirectHomeToRoot) {
      this.currentUrl = this.rootLandingUrl;
      this.state = X_PAGE_STATES.UNKNOWN;
      this.pendingHomeTransition = this.homeSettlesToBareRoot;
    } else if (url === "https://x.com/i/flow/login" && this.loginStaysOnRoot) {
      this.currentUrl = "https://x.com/";
      this.state = X_PAGE_STATES.UNKNOWN;
    } else if (
      url === "https://x.com/i/flow/login" &&
      this.combinedLoginRoute
    ) {
      if (this.loginSettlesToCombined) {
        this.currentUrl = "https://x.com/";
        this.state = X_PAGE_STATES.UNKNOWN;
        this.pendingLoginTransition = true;
      } else {
        this.currentUrl = "https://x.com/i/jf/onboarding/web?mode=login";
        this.state = X_PAGE_STATES.COMBINED_LOGIN_REQUIRED;
        this.combinedPhase = "identifier";
      }
    } else {
      this.currentUrl = "https://x.com/i/flow/login";
    }
    this.gotoCalls.push({ url, options });
  }

  getByRole(role, { name }) {
    return new FakeLocator(this, { kind: "role", role, name });
  }

  getByText(name, { exact }) {
    return new FakeLocator(this, { kind: "text", name, exact });
  }

  locator(selector) {
    return new FakeLocator(this, { kind: "css", selector });
  }

  isVisible(spec) {
    switch (this.state) {
      case X_PAGE_STATES.AUTHENTICATED:
        return (
          isForYou(spec) ||
          (this.genericLoginControlsOnHome &&
            (isLoginIdentifier(spec) ||
              isLoginNext(spec) ||
              isUsernamePrompt(spec))) ||
          (spec.kind === "css" &&
            [
              'a[data-testid="AppTabBar_Home_Link"]',
              'main [data-testid="primaryColumn"]',
              'main article[data-testid="tweet"]',
            ].includes(spec.selector))
        );
      case X_PAGE_STATES.LOGIN_REQUIRED:
        return isLoginIdentifier(spec) || isLoginNext(spec);
      case X_PAGE_STATES.COMBINED_LOGIN_REQUIRED:
        return (
          isCombinedLoginForm(spec) ||
          isCombinedLoginIdentifierForm(spec) ||
          isCombinedLoginPasswordForm(spec) ||
          isCombinedLoginIdentifier(spec) ||
          isCombinedLoginPassword(spec) ||
          (this.combinedPhase === "identifier" &&
            isCombinedLoginContinue(spec) &&
            this.combinedIdentifierFilled) ||
          (this.combinedPhase === "password" &&
            isCombinedLoginSubmit(spec) &&
            this.combinedPasswordFilled &&
            this.combinedSubmitWaits >= this.combinedSubmitDelayWaits)
        );
      case X_PAGE_STATES.USE_PASSWORD_REQUIRED:
        return (
          (isLoginUsePassword(spec) &&
            this.combinedUsePasswordVisible &&
            this.combinedUsePasswordWaits >=
              this.combinedUsePasswordDelayWaits) ||
          isOneTimeCode(spec)
        );
      case X_PAGE_STATES.USERNAME_REQUIRED:
        return (
          isLoginIdentifier(spec) || isLoginNext(spec) || isUsernamePrompt(spec)
        );
      case X_PAGE_STATES.PASSWORD_REQUIRED:
        return isPassword(spec) || isLoginSubmit(spec);
      case X_PAGE_STATES.CHALLENGE:
        return isChallenge(spec);
      default:
        return false;
    }
  }

  afterFill(spec) {
    if (isCombinedLoginIdentifier(spec)) this.combinedIdentifierFilled = true;
    if (isPassword(spec) || isCombinedLoginPassword(spec)) {
      this.combinedPasswordFilled = true;
    }
  }

  afterClick(spec) {
    if (
      this.combinedPhase === "identifier" &&
      isCombinedLoginContinue(spec)
    ) {
      this.state = X_PAGE_STATES.USE_PASSWORD_REQUIRED;
      this.combinedPhase = "use-password";
      return;
    }

    if (
      this.combinedPhase === "use-password" &&
      isLoginUsePassword(spec)
    ) {
      if (this.combinedUsePasswordClickTransitions) {
        this.state = X_PAGE_STATES.COMBINED_LOGIN_REQUIRED;
        this.combinedPhase = "password";
      }
      return;
    }

    if (isLoginNext(spec)) {
      if (this.navigateExternallyOnNext) {
        this.currentUrl = "https://attacker.example/capture";
        return;
      }
      this.state = this.nextStates.shift() ?? this.state;
      if (this.state === X_PAGE_STATES.AUTHENTICATED) {
        this.currentUrl = "https://x.com/home";
      } else if (this.state === X_PAGE_STATES.CHALLENGE) {
        this.currentUrl = "https://x.com/i/flow/challenge";
      }
      return;
    }

    if (
      isLoginSubmit(spec) ||
      (this.combinedPhase === "password" && isCombinedLoginSubmit(spec))
    ) {
      this.state = this.submitState;
      if (this.state === X_PAGE_STATES.AUTHENTICATED) {
        this.currentUrl = "https://x.com/home";
      } else if (this.state === X_PAGE_STATES.CHALLENGE) {
        this.currentUrl = "https://x.com/i/flow/challenge";
      }
      return;
    }

    if (isForYou(spec) && this.selectForYouOnClick) {
      this.forYouSelected = true;
    }
  }

  async evaluate() {
    this.actions.push({ type: "evaluate" });
  }

  async waitForTimeout(milliseconds) {
    this.waitCalls.push(milliseconds);
    if (
      this.state === X_PAGE_STATES.COMBINED_LOGIN_REQUIRED &&
      this.combinedPhase === "password" &&
      this.combinedIdentifierFilled &&
      this.combinedPasswordFilled
    ) {
      this.combinedSubmitWaits += 1;
      if (
        this.combinedSubmitWaits === 1 &&
        this.combinedSubmitNavigateOnWait
      ) {
        this.currentUrl = this.combinedSubmitNavigateOnWait;
      }
    }
    if (
      this.state === X_PAGE_STATES.USE_PASSWORD_REQUIRED &&
      this.combinedPhase === "use-password"
    ) {
      this.combinedUsePasswordWaits += 1;
      if (
        this.combinedUsePasswordWaits === 1 &&
        this.combinedUsePasswordNavigateOnWait
      ) {
        this.currentUrl = this.combinedUsePasswordNavigateOnWait;
      }
    }
    if (this.pendingHomeTransition) {
      this.pendingHomeTransition = false;
      this.currentUrl = "https://x.com/";
      this.state = X_PAGE_STATES.UNKNOWN;
    } else if (this.pendingLoginTransition) {
      this.pendingLoginTransition = false;
      this.currentUrl = "https://x.com/i/jf/onboarding/web?mode=login";
      this.state = X_PAGE_STATES.COMBINED_LOGIN_REQUIRED;
      this.combinedPhase = "identifier";
    }
  }

  async route(_pattern, handler) {
    this.routeHandler = handler;
  }

  context() {
    return this;
  }

  on(event, handler) {
    this.listeners.set(event, handler);
  }

  mainFrame() {
    return this.frame;
  }

  async dispatchRequest(
    url,
    {
      navigation = true,
      mainFrame = true,
      requestPage = this,
      frameThrows = false,
    } = {},
  ) {
    const outcome = { aborted: null, continued: false };
    const requestFrame = mainFrame
      ? requestPage.mainFrame()
      : Object.freeze({ kind: "child", page: () => requestPage });
    const request = {
      frame: () => {
        if (frameThrows) throw new Error("synthetic frame unavailable");
        return requestFrame;
      },
      isNavigationRequest: () => navigation,
      url: () => url,
    };
    const route = {
      abort: async (reason) => {
        outcome.aborted = reason;
      },
      continue: async () => {
        outcome.continued = true;
      },
      request: () => request,
    };

    assert.equal(typeof this.routeHandler, "function");
    await this.routeHandler(route);
    return outcome;
  }
}

function actionKinds(page) {
  return page.actions.map((action) => {
    if (action.type === "fill") {
      if (isPassword(action.spec) || isCombinedLoginPassword(action.spec)) {
        return "fill-password";
      }
      return "fill-identifier";
    }
    if (action.type === "click") {
      if (isLoginUsePassword(action.spec)) return "click-use-password";
      if (
        action.combinedPhase === "identifier" &&
        isCombinedLoginContinue(action.spec)
      ) {
        return "click-next";
      }
      if (isLoginNext(action.spec)) return "click-next";
      if (isLoginSubmit(action.spec) || isCombinedLoginSubmit(action.spec)) {
        return "click-login";
      }
      if (isForYou(action.spec)) return "click-for-you";
    }
    return action.type;
  });
}

test("X navigation accepts only exact approved HTTPS hostnames", () => {
  for (const url of [
    "https://x.com/home",
    "https://www.x.com/i/flow/login",
    "https://twitter.com/home",
    "https://www.twitter.com/home",
  ]) {
    assert.equal(isAllowedXUrl(url), true, url);
  }

  for (const url of [
    "http://x.com/home",
    "https://x.com:444/home",
    "https://help.x.com/home",
    "https://x.com.attacker.example/home",
    "https://x.com@attacker.example/home",
    "https://attacker@x.com/home",
    "javascript:alert(1)",
    "not a URL",
  ]) {
    assert.equal(isAllowedXUrl(url), false, url);
  }

  assert.equal(isAllowedXUrl("about:blank"), false);
  assert.equal(isAllowedXUrl("about:blank", { allowBlank: true }), true);
  assert.equal(
    sanitizePageUrl("https://x.com/home?token=not-retained#private"),
    "https://x.com/home",
  );
  assert.equal(sanitizePageUrl("https://attacker.example/collect"), "[blocked]");
});

test("navigation guard aborts external top-level navigation and fails closed", async () => {
  const page = new FakePage({ state: X_PAGE_STATES.AUTHENTICATED });
  const guard = await installNavigationGuard(page);

  const allowed = await page.dispatchRequest("https://x.com/home");
  assert.deepEqual(allowed, { aborted: null, continued: true });

  const subresource = await page.dispatchRequest(
    "https://static.example/image.png",
    { navigation: false },
  );
  assert.deepEqual(subresource, { aborted: null, continued: true });

  const blocked = await page.dispatchRequest(
    "https://x.com.attacker.example/capture",
  );
  assert.deepEqual(blocked, {
    aborted: "blockedbyclient",
    continued: false,
  });
  assert.throws(
    () => guard.assertSafe(),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
});

test("navigation guard blocks popup-first and frameless navigation", async () => {
  const page = new FakePage({ state: X_PAGE_STATES.AUTHENTICATED });
  const popup = new FakePage({ state: X_PAGE_STATES.AUTHENTICATED });
  const guard = await installNavigationGuard(page);

  const popupFirstRequest = await page.dispatchRequest("https://x.com/home", {
    requestPage: popup,
  });
  assert.deepEqual(popupFirstRequest, {
    aborted: "blockedbyclient",
    continued: false,
  });
  assert.throws(
    () => guard.assertSafe(),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );

  const freshPage = new FakePage({ state: X_PAGE_STATES.AUTHENTICATED });
  const freshGuard = await installNavigationGuard(freshPage);
  const frameless = await freshPage.dispatchRequest("https://x.com/home", {
    frameThrows: true,
  });
  assert.deepEqual(frameless, {
    aborted: "blockedbyclient",
    continued: false,
  });
  assert.throws(
    () => freshGuard.assertSafe(),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
});

test("navigation guard permits only the initial blank page before Home", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    url: "about:blank",
  });
  const guard = await installNavigationGuard(page);
  assert.equal(guard.assertSafe(), true);

  const rootRequest = await page.dispatchRequest("https://x.com/");
  assert.deepEqual(rootRequest, { aborted: null, continued: true });
  page.currentUrl = "https://x.com/";
  assert.equal(guard.assertSafe(), true);

  const homeRequest = await page.dispatchRequest("https://x.com/home");
  assert.deepEqual(homeRequest, { aborted: null, continued: true });
  page.currentUrl = "https://x.com/home";
  assert.equal(guard.assertSafe(), true);

  page.currentUrl = "about:blank";
  assert.throws(
    () => guard.assertSafe(),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
});

test("workflow navigation allows only the exact X root landing path", () => {
  assert.equal(isAllowedXWorkflowUrl("https://x.com/"), true);
  assert.equal(isAllowedXWorkflowUrl("https://x.com"), true);

  for (const url of [
    "https://x.com//",
    "https://x.com/messages",
    "https://x.com.attacker.example/",
  ]) {
    assert.equal(isAllowedXWorkflowUrl(url), false, url);
  }
});

test("combined login navigation allows only X's exact observed mode", async () => {
  const exact = "https://x.com/i/jf/onboarding/web?mode=login";
  assert.equal(isAllowedXCombinedLoginUrl(exact), true);
  assert.equal(isAllowedXLoginUrl(exact), true);
  assert.equal(isAllowedXWorkflowUrl(exact), true);

  for (const url of [
    "https://www.x.com/i/jf/onboarding/web?mode=login",
    "https://x.com/i/jf/onboarding/web",
    "https://x.com/i/jf/onboarding/web/?mode=login",
    "https://x.com/i/jf/onboarding/web?mode=signup",
    "https://x.com/i/jf/onboarding/web?mode=login&mode=login",
    "https://x.com/i/jf/onboarding/web?mode=login&extra=1",
    "https://x.com/i/jf/onboarding/web?mode=login#step",
    "https://x.com:444/i/jf/onboarding/web?mode=login",
    "https://attacker.example/i/jf/onboarding/web?mode=login",
  ]) {
    assert.equal(isAllowedXCombinedLoginUrl(url), false, url);
    assert.equal(isAllowedXLoginUrl(url), false, url);
    assert.equal(isAllowedXWorkflowUrl(url), false, url);
  }

  const page = new FakePage({ state: X_PAGE_STATES.UNKNOWN });
  const guard = await installNavigationGuard(page);
  assert.deepEqual(await page.dispatchRequest(exact), {
    aborted: null,
    continued: true,
  });
  assert.deepEqual(
    await page.dispatchRequest(
      "https://x.com/i/jf/onboarding/web?mode=signup",
    ),
    { aborted: "blockedbyclient", continued: false },
  );
  assert.throws(
    () => guard.assertSafe(),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
});

test("approved actions reject external pages before acting and after navigation", async () => {
  const externalPage = new FakePage({
    state: X_PAGE_STATES.LOGIN_REQUIRED,
    url: "https://attacker.example/login",
  });

  await assert.rejects(
    performReadOnlyAction(
      externalPage,
      X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT,
    ),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
  assert.deepEqual(externalPage.actions, []);

  const wrongPhasePage = new FakePage({
    state: X_PAGE_STATES.LOGIN_REQUIRED,
    url: "https://x.com/home",
  });
  await assert.rejects(
    performReadOnlyAction(
      wrongPhasePage,
      X_READ_ONLY_ACTIONS.FILL_LOGIN_IDENTIFIER,
      "must-not-be-filled",
    ),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
  assert.deepEqual(wrongPhasePage.actions, []);

  const redirectingPage = new FakePage({
    state: X_PAGE_STATES.LOGIN_REQUIRED,
    url: "https://x.com/i/flow/login",
    navigateExternallyOnNext: true,
  });
  await assert.rejects(
    performReadOnlyAction(
      redirectingPage,
      X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT,
    ),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
  assert.deepEqual(actionKinds(redirectingPage), ["click-next"]);
});

test("credential fills recheck permission and exact route immediately before mutation", async () => {
  for (const fixture of [
    {
      action: X_READ_ONLY_ACTIONS.FILL_LOGIN_IDENTIFIER,
      value: "must-not-be-filled@example.test",
      target: isCombinedLoginIdentifier,
    },
    {
      action: X_READ_ONLY_ACTIONS.FILL_LOGIN_PASSWORD,
      value: "must-not-be-filled",
      target: isCombinedLoginPassword,
    },
  ]) {
    const revoked = new FakePage({
      state: X_PAGE_STATES.COMBINED_LOGIN_REQUIRED,
      url: "https://x.com/i/jf/onboarding/web?mode=login",
    });
    let permissionChecks = 0;
    await assert.rejects(
      performReadOnlyAction(revoked, fixture.action, fixture.value, {
        assertPermissionActive() {
          permissionChecks += 1;
          if (permissionChecks === 2) {
            const error = new Error("permission revoked");
            error.code = "FEATURE_DISABLED";
            throw error;
          }
        },
      }),
      (error) => error?.code === "FEATURE_DISABLED",
    );
    assert.deepEqual(revoked.actions, []);

    const drifted = new FakePage({
      state: X_PAGE_STATES.COMBINED_LOGIN_REQUIRED,
      url: "https://x.com/i/jf/onboarding/web?mode=login",
    });
    const originalIsVisible = drifted.isVisible.bind(drifted);
    drifted.isVisible = (spec) => {
      const visible = originalIsVisible(spec);
      if (fixture.target(spec)) drifted.currentUrl = "https://x.com/";
      return visible;
    };
    await assert.rejects(
      performReadOnlyAction(drifted, fixture.action, fixture.value),
      (error) => error?.code === "NAVIGATION_BLOCKED",
    );
    assert.deepEqual(drifted.actions, []);
  }
});

test("read-only action surface has no unsupported timeline mutations", async () => {
  assert.deepEqual(Object.values(X_READ_ONLY_ACTIONS), [
    "fill-login-identifier",
    "click-login-next",
    "click-login-use-password",
    "fill-login-username",
    "fill-login-password",
    "click-login-submit",
    "click-for-you",
    "scroll-feed",
  ]);

  const page = new FakePage({ state: X_PAGE_STATES.AUTHENTICATED });
  for (const action of [
    "like",
    "repost",
    "reply",
    "follow",
    "bookmark",
    "direct-message",
    "create-post",
    "open-external-link",
    "change-settings",
  ]) {
    await assert.rejects(
      performReadOnlyAction(page, action),
      (error) => error?.code === "ACTION_BLOCKED",
    );
  }
  assert.deepEqual(page.actions, []);
});

test("locator fallback survives one detached locator and rejects unknown specs", async () => {
  const detached = {
    first() {
      return this;
    },
    async isVisible() {
      throw new Error("detached");
    },
  };
  const visible = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
  };
  const root = {
    getByRole: () => detached,
    getByText: () => ({ ...visible, isVisible: async () => false }),
    locator: () => visible,
  };

  const match = await findVisibleLocator(root, X_LOCATORS.loginIdentifier);
  assert.equal(match.locator, visible);
  assert.equal(match.spec.selector, 'input[autocomplete="username"]');
  assert.throws(
    () => locatorFromSpec(root, { kind: "unsupported" }),
    /Unknown X locator specification/,
  );
});

test("combined login method controls use exact accessible button names", () => {
  const [continueSpec] = X_LOCATORS.combinedLoginContinue;
  const [usePasswordSpec] = X_LOCATORS.loginUsePassword;
  const [submitSpec, submitFallbackSpec] = X_LOCATORS.combinedLoginSubmit;

  for (const spec of [
    continueSpec,
    usePasswordSpec,
    submitSpec,
    submitFallbackSpec,
  ]) {
    assert.equal(spec.kind, "role");
    assert.equal(spec.role, "button");
  }

  assert.equal(nameMatches(continueSpec.name, "Continue"), true);
  assert.equal(nameMatches(continueSpec.name, "Continue with phone"), false);
  assert.equal(nameMatches(usePasswordSpec.name, "Use password"), true);
  assert.equal(
    nameMatches(usePasswordSpec.name, "Use a password manager"),
    false,
  );
  assert.equal(nameMatches(submitSpec.name, "Log in"), true);
  assert.equal(nameMatches(submitSpec.name, "Log in with Google"), false);
  assert.equal(nameMatches(submitFallbackSpec.name, "Continue"), true);
  assert.equal(
    nameMatches(submitFallbackSpec.name, "Continue with phone"),
    false,
  );
});

test("page-state detection distinguishes authentication, login, and challenge", async () => {
  for (const state of [
    X_PAGE_STATES.AUTHENTICATED,
    X_PAGE_STATES.COMBINED_LOGIN_REQUIRED,
    X_PAGE_STATES.USE_PASSWORD_REQUIRED,
    X_PAGE_STATES.LOGIN_REQUIRED,
    X_PAGE_STATES.ROOT_LANDING,
    X_PAGE_STATES.USERNAME_REQUIRED,
    X_PAGE_STATES.PASSWORD_REQUIRED,
    X_PAGE_STATES.CHALLENGE,
    X_PAGE_STATES.UNKNOWN,
  ]) {
    const url = [
      X_PAGE_STATES.COMBINED_LOGIN_REQUIRED,
      X_PAGE_STATES.USE_PASSWORD_REQUIRED,
    ].includes(state)
      ? "https://x.com/i/jf/onboarding/web?mode=login"
      : state === X_PAGE_STATES.ROOT_LANDING
        ? "https://x.com/"
      : [
          X_PAGE_STATES.LOGIN_REQUIRED,
          X_PAGE_STATES.USERNAME_REQUIRED,
          X_PAGE_STATES.PASSWORD_REQUIRED,
        ].includes(state)
        ? "https://x.com/i/flow/login"
        : state === X_PAGE_STATES.CHALLENGE
          ? "https://x.com/i/flow/challenge"
          : "https://x.com/home";
    const page = new FakePage({
      state,
      url,
    });
    assert.equal(await detectXPageState(page), state);
  }

  const challengeUrl = new FakePage({
    state: X_PAGE_STATES.AUTHENTICATED,
    url: "https://x.com/i/flow/challenge/step",
  });
  assert.equal(await detectXPageState(challengeUrl), X_PAGE_STATES.CHALLENGE);

  const passwordlessPrompt = new FakePage({
    state: X_PAGE_STATES.USE_PASSWORD_REQUIRED,
    url: "https://x.com/i/jf/onboarding/web?mode=login",
  });
  assert.equal(
    await detectXPageState(passwordlessPrompt),
    X_PAGE_STATES.USE_PASSWORD_REQUIRED,
  );
  const originalIsVisible = passwordlessPrompt.isVisible.bind(passwordlessPrompt);
  passwordlessPrompt.isVisible = (spec) =>
    isOneTimeCode(spec) ? false : originalIsVisible(spec);
  assert.equal(
    await detectXPageState(passwordlessPrompt),
    X_PAGE_STATES.USE_PASSWORD_REQUIRED,
  );
  passwordlessPrompt.isVisible = originalIsVisible;
  passwordlessPrompt.combinedUsePasswordVisible = false;
  assert.equal(
    await detectXPageState(passwordlessPrompt),
    X_PAGE_STATES.CHALLENGE,
  );
});

test("login controls are classified only on an approved login route", async () => {
  const rootPassword = new FakePage({
    state: X_PAGE_STATES.PASSWORD_REQUIRED,
    url: "https://x.com/",
  });
  assert.equal(
    await detectXPageState(rootPassword),
    X_PAGE_STATES.ROOT_LANDING,
  );
  await assert.rejects(
    performReadOnlyAction(
      rootPassword,
      X_READ_ONLY_ACTIONS.FILL_LOGIN_PASSWORD,
      "must-not-be-filled",
    ),
    (error) => error?.code === "NAVIGATION_BLOCKED",
  );
  assert.deepEqual(rootPassword.actions, []);

  const homePassword = new FakePage({
    state: X_PAGE_STATES.PASSWORD_REQUIRED,
    url: "https://x.com/home",
  });
  assert.equal(await detectXPageState(homePassword), X_PAGE_STATES.UNKNOWN);

  const loginAuthenticated = new FakePage({
    state: X_PAGE_STATES.AUTHENTICATED,
    url: "https://x.com/i/flow/login",
  });
  assert.equal(await detectXPageState(loginAuthenticated), X_PAGE_STATES.UNKNOWN);

  const signupCombined = new FakePage({
    state: X_PAGE_STATES.COMBINED_LOGIN_REQUIRED,
    url: "https://x.com/i/jf/onboarding/web?mode=signup",
  });
  assert.equal(await detectXPageState(signupCombined), X_PAGE_STATES.UNKNOWN);
});

test("authenticated session is reused without reading or filling credentials", async () => {
  const page = new FakePage({ state: X_PAGE_STATES.AUTHENTICATED });
  const events = [];
  const method = await ensureXAuthenticated(page, {
    env: {},
    stateTimeoutMs: 1,
    log: (event, metadata) => events.push({ event, metadata }),
  });

  assert.equal(method, "existing-session");
  assert.deepEqual(page.gotoCalls, [
    {
      url: "https://x.com/home",
      options: { waitUntil: "domcontentloaded" },
    },
  ]);
  assert.deepEqual(page.actions, []);
  assert.deepEqual(events, [
    { event: "AUTH_SESSION_REUSED", metadata: undefined },
  ]);
});

test("generic Home text inputs are never treated as login controls", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.AUTHENTICATED,
    genericLoginControlsOnHome: true,
  });
  const method = await ensureXAuthenticated(page, {
    env: {
      X_LOGIN_EMAIL: "must-not-be-used@example.test",
      X_LOGIN_USERNAME: "@must_not_be_used",
      X_LOGIN_PASSWORD: "must-not-be-used",
    },
    stateTimeoutMs: 1,
  });

  assert.equal(method, "existing-session");
  assert.deepEqual(page.actions, []);
});

test("root landing selects the exact password method before one login submit", async () => {
  const email = "collector@example.test";
  const password = "synthetic-password-never-log";
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    redirectHomeToRoot: true,
    combinedLoginRoute: true,
    combinedSubmitDelayWaits: 2,
    submitState: X_PAGE_STATES.AUTHENTICATED,
  });

  const method = await ensureXAuthenticated(page, {
    env: {
      X_LOGIN_EMAIL: email,
      X_LOGIN_PASSWORD: password,
    },
    stateTimeoutMs: 1,
  });

  assert.equal(method, "credentials");
  assert.deepEqual(page.gotoCalls, [
    {
      url: "https://x.com/home",
      options: { waitUntil: "domcontentloaded" },
    },
    {
      url: "https://x.com/i/flow/login",
      options: { waitUntil: "domcontentloaded" },
    },
  ]);
  assert.deepEqual(actionKinds(page), [
    "fill-identifier",
    "click-next",
    "click-use-password",
    "fill-password",
    "click-login",
  ]);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "fill").map(({ value }) => value),
    [email, password],
  );
  assert.deepEqual(page.waitCalls, [200, 200]);
});

test("a missing Use password control fails closed without entering a password", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.USE_PASSWORD_REQUIRED,
    url: "https://x.com/i/jf/onboarding/web?mode=login",
    combinedUsePasswordVisible: false,
  });

  await assert.rejects(
    performReadOnlyAction(
      page,
      X_READ_ONLY_ACTIONS.CLICK_LOGIN_USE_PASSWORD,
    ),
    (error) =>
      error?.code === "SELECTOR_DRIFT" &&
      error?.locator === X_READ_ONLY_ACTIONS.CLICK_LOGIN_USE_PASSWORD,
  );
  assert.equal(
    actionKinds(page).filter((action) => action === "click-use-password").length,
    0,
  );
  assert.equal(
    actionKinds(page).filter((action) => action === "fill-password").length,
    0,
  );
  assert.equal(
    page.actions.some(({ spec }) => isOneTimeCode(spec)),
    false,
  );
});

test("permission revocation while Use password materializes never clicks", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.USE_PASSWORD_REQUIRED,
    url: "https://x.com/i/jf/onboarding/web?mode=login",
    combinedUsePasswordDelayWaits: 10,
  });

  await assert.rejects(
    performReadOnlyAction(
      page,
      X_READ_ONLY_ACTIONS.CLICK_LOGIN_USE_PASSWORD,
      undefined,
      {
        assertPermissionActive() {
          if (page.combinedUsePasswordWaits === 1) {
            const error = new Error("permission revoked");
            error.code = "FEATURE_DISABLED";
            throw error;
          }
        },
      },
    ),
    (error) => error?.code === "FEATURE_DISABLED",
  );
  assert.equal(
    actionKinds(page).filter((action) => action === "click-use-password").length,
    0,
  );
  assert.equal(
    actionKinds(page).filter((action) => action === "fill-password").length,
    0,
  );
  assert.deepEqual(page.waitCalls, [200]);
});

test("Use password route drift during materialization never clicks", async () => {
  for (const combinedUsePasswordNavigateOnWait of [
    "https://x.com/",
    "https://x.com/i/flow/login",
  ]) {
    const page = new FakePage({
      state: X_PAGE_STATES.USE_PASSWORD_REQUIRED,
      url: "https://x.com/i/jf/onboarding/web?mode=login",
      combinedUsePasswordDelayWaits: 10,
      combinedUsePasswordNavigateOnWait,
    });

    await assert.rejects(
      performReadOnlyAction(
        page,
        X_READ_ONLY_ACTIONS.CLICK_LOGIN_USE_PASSWORD,
      ),
      (error) => error?.code === "NAVIGATION_BLOCKED",
      combinedUsePasswordNavigateOnWait,
    );
    assert.equal(
      actionKinds(page).filter(
        (action) => action === "click-use-password",
      ).length,
      0,
      combinedUsePasswordNavigateOnWait,
    );
    assert.equal(
      actionKinds(page).filter((action) => action === "fill-password").length,
      0,
      combinedUsePasswordNavigateOnWait,
    );
    assert.deepEqual(
      page.waitCalls,
      [200],
      combinedUsePasswordNavigateOnWait,
    );
  }
});

test("a Use password click that does not change methods never enters a password", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    redirectHomeToRoot: true,
    combinedLoginRoute: true,
    combinedUsePasswordClickTransitions: false,
  });

  await assert.rejects(
    ensureXAuthenticated(page, {
      env: {
        X_LOGIN_EMAIL: "collector@example.test",
        X_LOGIN_PASSWORD: "must-not-be-entered",
      },
      stateTimeoutMs: 1,
    }),
    (error) => error?.code === "AUTH_FAILED",
  );
  assert.deepEqual(actionKinds(page), [
    "fill-identifier",
    "click-next",
    "click-use-password",
  ]);
  assert.equal(page.combinedPasswordFilled, false);
});

test("permission revocation while the exact combined submit materializes never clicks", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    redirectHomeToRoot: true,
    combinedLoginRoute: true,
    combinedSubmitDelayWaits: 10,
  });

  await assert.rejects(
    ensureXAuthenticated(page, {
      env: {
        X_LOGIN_EMAIL: "collector@example.test",
        X_LOGIN_PASSWORD: "synthetic-password",
      },
      stateTimeoutMs: 20,
      assertPermissionActive() {
        if (
          page.combinedPasswordFilled &&
          page.combinedSubmitWaits === 1
        ) {
          const error = new Error("permission revoked");
          error.code = "FEATURE_DISABLED";
          throw error;
        }
      },
    }),
    (error) => error?.code === "FEATURE_DISABLED",
  );
  assert.equal(
    actionKinds(page).filter((action) => action === "click-login").length,
    0,
  );
  assert.deepEqual(page.waitCalls, [200]);
});

test("combined submit route drift during materialization never clicks", async () => {
  for (const combinedSubmitNavigateOnWait of [
    "https://x.com/",
    "https://x.com/i/flow/login",
  ]) {
    const page = new FakePage({
      state: X_PAGE_STATES.UNKNOWN,
      redirectHomeToRoot: true,
      combinedLoginRoute: true,
      combinedSubmitDelayWaits: 10,
      combinedSubmitNavigateOnWait,
    });

    await assert.rejects(
      ensureXAuthenticated(page, {
        env: {
          X_LOGIN_EMAIL: "collector@example.test",
          X_LOGIN_PASSWORD: "synthetic-password",
        },
        stateTimeoutMs: 20,
      }),
      (error) => error?.code === "NAVIGATION_BLOCKED",
      combinedSubmitNavigateOnWait,
    );
    assert.equal(
      actionKinds(page).filter((action) => action === "click-login").length,
      0,
      combinedSubmitNavigateOnWait,
    );
    assert.deepEqual(page.waitCalls, [200], combinedSubmitNavigateOnWait);
  }
});

test("non-exact root landings never enter credentials", async () => {
  for (const rootLandingUrl of [
    "https://x.com/?mode=login",
    "https://x.com/#login",
    "https://www.x.com/",
  ]) {
    const page = new FakePage({
      state: X_PAGE_STATES.UNKNOWN,
      redirectHomeToRoot: true,
      combinedLoginRoute: true,
      rootLandingUrl,
    });

    await assert.rejects(
      ensureXAuthenticated(page, {
        env: {
          X_LOGIN_EMAIL: "must-not-be-entered@example.test",
          X_LOGIN_PASSWORD: "must-not-be-entered",
        },
        stateTimeoutMs: 1,
      }),
      (error) => error?.code === "AUTH_FAILED",
    );
    assert.equal(page.gotoCalls.length, 1, rootLandingUrl);
    assert.deepEqual(page.actions, [], rootLandingUrl);
  }
});

test("transient root shells settle before the exact combined login acts", async () => {
  const email = "collector@example.test";
  const password = "synthetic-password-never-log";
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    redirectHomeToRoot: true,
    rootLandingUrl: "https://x.com/?transient=1",
    homeSettlesToBareRoot: true,
    combinedLoginRoute: true,
    loginSettlesToCombined: true,
    submitState: X_PAGE_STATES.AUTHENTICATED,
  });

  const method = await ensureXAuthenticated(page, {
    env: {
      X_LOGIN_EMAIL: email,
      X_LOGIN_PASSWORD: password,
    },
    stateTimeoutMs: 1_000,
  });

  assert.equal(method, "credentials");
  assert.deepEqual(actionKinds(page), [
    "fill-identifier",
    "click-next",
    "click-use-password",
    "fill-password",
    "click-login",
  ]);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "fill").map(({ value }) => value),
    [email, password],
  );
  assert.ok(page.waitCalls.length >= 2);
  assert.ok(
    page.actions.every(
      (action) => action.url === "https://x.com/i/jf/onboarding/web?mode=login",
    ),
  );
});

test("a login root shell that never reaches an approved form performs no actions", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    redirectHomeToRoot: true,
    loginStaysOnRoot: true,
  });

  await assert.rejects(
    ensureXAuthenticated(page, {
      env: {
        X_LOGIN_EMAIL: "must-not-be-entered@example.test",
        X_LOGIN_PASSWORD: "must-not-be-entered",
      },
      stateTimeoutMs: 1,
    }),
    (error) => error?.code === "AUTH_FAILED",
  );
  assert.equal(page.gotoCalls.length, 2);
  assert.deepEqual(page.actions, []);
});

test("permission revocation during a root-shell transition performs no actions", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.UNKNOWN,
    redirectHomeToRoot: true,
    combinedLoginRoute: true,
    loginSettlesToCombined: true,
  });
  let permissionChecks = 0;

  await assert.rejects(
    ensureXAuthenticated(page, {
      env: {
        X_LOGIN_EMAIL: "must-not-be-entered@example.test",
        X_LOGIN_PASSWORD: "must-not-be-entered",
      },
      stateTimeoutMs: 20,
      assertPermissionActive() {
        permissionChecks += 1;
        if (permissionChecks === 5) {
          const error = new Error("permission revoked");
          error.code = "FEATURE_DISABLED";
          throw error;
        }
      },
    }),
    (error) => error?.code === "FEATURE_DISABLED",
  );
  assert.equal(permissionChecks, 5);
  assert.deepEqual(page.actions, []);
});

test("combined login submits at most once and fails closed", async () => {
  const password = "single-synthetic-attempt";

  for (const fixture of [
    {
      name: "rejected credentials",
      submitState: X_PAGE_STATES.COMBINED_LOGIN_REQUIRED,
      expectedCode: "AUTH_FAILED",
      finalEvent: "AUTH_FAILED",
    },
    {
      name: "challenge",
      submitState: X_PAGE_STATES.CHALLENGE,
      expectedCode: "MANUAL_ACTION_REQUIRED",
      finalEvent: "MANUAL_ACTION_REQUIRED",
    },
  ]) {
    const page = new FakePage({
      state: X_PAGE_STATES.UNKNOWN,
      redirectHomeToRoot: true,
      combinedLoginRoute: true,
      submitState: fixture.submitState,
    });
    const events = [];

    await assert.rejects(
      ensureXAuthenticated(page, {
        env: {
          X_LOGIN_EMAIL: "collector@example.test",
          X_LOGIN_PASSWORD: password,
        },
        interactiveChallenges: false,
        stateTimeoutMs: 1,
        log: (event, metadata) => events.push({ event, metadata }),
      }),
      (error) => error?.code === fixture.expectedCode,
      fixture.name,
    );

    assert.equal(
      actionKinds(page).filter((action) => action === "fill-password").length,
      1,
      fixture.name,
    );
    assert.equal(
      actionKinds(page).filter((action) => action === "click-login").length,
      1,
      fixture.name,
    );
    assert.equal(events.at(-1)?.event, fixture.finalEvent, fixture.name);
    assert.equal(JSON.stringify(events).includes(password), false, fixture.name);
  }
});

test("lowercase email/password aliases complete login without entering log metadata", async () => {
  const email = "collector@example.test";
  const username = "@collector_account";
  const password = "synthetic-password-never-log";
  const credentials = resolveXLoginCredentials({
    x_email: email,
    X_LOGIN_USERNAME: username,
    x_password: password,
  });
  assert.deepEqual(credentials, { email, username, password });
  assert.equal(Object.isFrozen(credentials), true);

  const page = new FakePage({
    state: X_PAGE_STATES.LOGIN_REQUIRED,
    nextStates: [
      X_PAGE_STATES.USERNAME_REQUIRED,
      X_PAGE_STATES.PASSWORD_REQUIRED,
    ],
    submitState: X_PAGE_STATES.AUTHENTICATED,
  });
  const events = [];
  const method = await ensureXAuthenticated(page, {
    env: {
      x_email: email,
      X_LOGIN_USERNAME: username,
      x_password: password,
    },
    stateTimeoutMs: 1,
    log: (event, metadata) => events.push({ event, metadata }),
  });

  assert.equal(method, "credentials");
  assert.deepEqual(actionKinds(page), [
    "fill-identifier",
    "click-next",
    "fill-identifier",
    "click-next",
    "fill-password",
    "click-login",
  ]);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "fill").map(({ value }) => value),
    [email, "collector_account", password],
  );
  assert.deepEqual(events, [
    { event: "AUTH_LOGIN_STARTED", metadata: undefined },
    { event: "AUTH_LOGIN_SUCCEEDED", metadata: { method: "credentials" } },
  ]);

  const serializedEvents = JSON.stringify(events);
  assert.equal(serializedEvents.includes(email), false);
  assert.equal(serializedEvents.includes(username), false);
  assert.equal(serializedEvents.includes(password), false);
});

test("a persistent profile resumed at username confirmation uses the username", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.USERNAME_REQUIRED,
    nextStates: [X_PAGE_STATES.PASSWORD_REQUIRED],
    submitState: X_PAGE_STATES.AUTHENTICATED,
  });

  const method = await ensureXAuthenticated(page, {
    env: {
      X_LOGIN_EMAIL: "must-not-be-entered@example.test",
      X_LOGIN_USERNAME: "@collector_account",
      X_LOGIN_PASSWORD: "synthetic-password",
    },
    stateTimeoutMs: 1,
  });

  assert.equal(method, "credentials");
  assert.deepEqual(actionKinds(page), [
    "fill-identifier",
    "click-next",
    "fill-password",
    "click-login",
  ]);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "fill").map(({ value }) => value),
    ["collector_account", "synthetic-password"],
  );
});

test("a failed password is submitted only once", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.LOGIN_REQUIRED,
    nextStates: [X_PAGE_STATES.PASSWORD_REQUIRED],
    submitState: X_PAGE_STATES.PASSWORD_REQUIRED,
  });
  const events = [];

  await assert.rejects(
    ensureXAuthenticated(page, {
      env: {
        X_LOGIN_EMAIL: "collector@example.test",
        X_LOGIN_PASSWORD: "one-attempt-only",
      },
      stateTimeoutMs: 1,
      log: (event, metadata) => events.push({ event, metadata }),
    }),
    (error) => error?.code === "AUTH_FAILED",
  );

  assert.equal(actionKinds(page).filter((action) => action === "fill-password").length, 1);
  assert.equal(actionKinds(page).filter((action) => action === "click-login").length, 1);
  assert.equal(events.at(-1)?.event, "AUTH_FAILED");
});

test("a post-submit challenge aborts unattended login after one password attempt", async () => {
  const password = "single-synthetic-attempt";
  const page = new FakePage({
    state: X_PAGE_STATES.LOGIN_REQUIRED,
    nextStates: [X_PAGE_STATES.PASSWORD_REQUIRED],
    submitState: X_PAGE_STATES.CHALLENGE,
  });
  const events = [];

  await assert.rejects(
    ensureXAuthenticated(page, {
      env: {
        X_LOGIN_EMAIL: "collector@example.test",
        X_LOGIN_PASSWORD: password,
      },
      interactiveChallenges: false,
      stateTimeoutMs: 1,
      log: (event, metadata) => events.push({ event, metadata }),
    }),
    (error) => error?.code === "MANUAL_ACTION_REQUIRED",
  );

  assert.equal(actionKinds(page).filter((action) => action === "fill-password").length, 1);
  assert.equal(actionKinds(page).filter((action) => action === "click-login").length, 1);
  assert.equal(events.at(-1)?.event, "MANUAL_ACTION_REQUIRED");
  assert.equal(JSON.stringify(events).includes(password), false);
});

test("For You selection succeeds only after aria-selected is confirmed", async () => {
  const page = new FakePage({
    state: X_PAGE_STATES.AUTHENTICATED,
    forYouSelected: false,
    selectForYouOnClick: true,
  });
  const events = [];

  await selectForYouFeed(page, {
    timeoutMs: 10,
    log: (event) => events.push(event),
  });

  assert.deepEqual(actionKinds(page), ["click-for-you"]);
  assert.ok(
    page.attributeReads.some(({ name }) => name === "aria-selected"),
  );
  assert.deepEqual(events, ["FOR_YOU_SELECTED"]);

  const unconfirmed = new FakePage({
    state: X_PAGE_STATES.AUTHENTICATED,
    forYouSelected: false,
    selectForYouOnClick: false,
  });
  await assert.rejects(
    selectForYouFeed(unconfirmed, { timeoutMs: 0 }),
    (error) =>
      error?.code === "SELECTOR_DRIFT" &&
      error?.locator === "for-you-tab[aria-selected=true]",
  );
  assert.deepEqual(actionKinds(unconfirmed), ["click-for-you"]);
});

test("requireAllowedXPage reports only a safe navigation failure", () => {
  const page = new FakePage({ url: "https://attacker.example/?secret=value" });
  assert.throws(
    () => requireAllowedXPage(page),
    (error) =>
      error?.code === "NAVIGATION_BLOCKED" &&
      !error.message.includes("attacker.example") &&
      !error.message.includes("secret"),
  );
});
