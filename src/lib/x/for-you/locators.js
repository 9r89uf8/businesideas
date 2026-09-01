function role(roleName, name) {
  return Object.freeze({ kind: "role", role: roleName, name });
}

function text(name, exact = false) {
  return Object.freeze({ kind: "text", name, exact });
}

function css(selector) {
  return Object.freeze({ kind: "css", selector });
}

export const X_LOCATORS = Object.freeze({
  authenticated: Object.freeze([
    role("tab", /^For you$/i),
    css('a[data-testid="AppTabBar_Home_Link"]'),
    css('main [data-testid="primaryColumn"]'),
  ]),
  authenticatedAccount: Object.freeze([
    css('a[data-testid="AppTabBar_Profile_Link"][href]'),
  ]),
  loginIdentifier: Object.freeze([
    role("textbox", /phone,? email,? or username/i),
    css('input[autocomplete="username"]'),
    css('input[name="text"]'),
  ]),
  combinedLoginForm: Object.freeze([
    css(
      'form:has(input[name="username_or_email"][type="text"]):has(input[name="password"][type="password"])',
    ),
  ]),
  combinedLoginPasswordForm: Object.freeze([
    css('form:has(input[name="password"][type="password"])'),
  ]),
  combinedLoginIdentifier: Object.freeze([
    css('input[name="username_or_email"][type="text"]'),
  ]),
  combinedLoginPassword: Object.freeze([
    css('input[name="password"][type="password"]'),
  ]),
  loginNext: Object.freeze([
    role("button", /^Next$/i),
    text("Next", true),
  ]),
  usernamePrompt: Object.freeze([
    text(/enter your phone number or username/i),
    text(/confirm your (?:phone number|username)/i),
  ]),
  password: Object.freeze([
    role("textbox", /^Password$/i),
    css('input[name="password"]'),
    css('input[type="password"]'),
  ]),
  loginSubmit: Object.freeze([
    role("button", /^Log in$/i),
    css('[data-testid="LoginForm_Login_Button"]'),
  ]),
  combinedLoginContinue: Object.freeze([
    role("button", /^Continue$/i),
  ]),
  loginUsePassword: Object.freeze([
    role("button", /^Use password$/i),
  ]),
  combinedLoginSubmit: Object.freeze([
    role("button", /^Continue$/i),
  ]),
  forYouTab: Object.freeze([
    role("tab", /^For you$/i),
  ]),
  timelinePost: Object.freeze([
    css('main article[data-testid="tweet"]'),
  ]),
  challengeHardStructural: Object.freeze([
    css('iframe[src*="captcha"]'),
    css('iframe[title*="challenge" i]'),
  ]),
  oneTimeCode: Object.freeze([
    css('input[autocomplete="one-time-code"]'),
    css('input[name="challenge_response"]'),
  ]),
  challengeWorkflowText: Object.freeze([
    text(/verify (?:that it'?s you|your identity|your account)/i),
    text(/unusual (?:activity|login)/i),
    text(/account access/i),
    text(/enter (?:the )?(?:verification|confirmation) code/i),
    text(/complete the (?:captcha|challenge)/i),
  ]),
  blockingHomeOverlay: Object.freeze([
    css('[role="dialog"]'),
  ]),
  feedErrorContainers: Object.freeze([
    css('main [role="alert"]'),
    css('main [data-testid="error-detail"]'),
    css('main [data-testid="emptyState"]'),
  ]),
  feedErrorText: Object.freeze([
    text(/something went wrong/i),
    text(/try reloading/i),
    text(/cannot retrieve (?:posts|tweets)/i),
  ]),
});

function locatorCollectionFromSpec(root, spec) {
  let locator;

  if (spec.kind === "role") {
    locator = root.getByRole(spec.role, { name: spec.name });
  } else if (spec.kind === "text") {
    locator = root.getByText(spec.name, { exact: spec.exact });
  } else if (spec.kind === "css") {
    locator = root.locator(spec.selector);
  } else {
    throw new TypeError("Unknown X locator specification.");
  }

  return locator;
}

export function locatorFromSpec(root, spec) {
  const locator = locatorCollectionFromSpec(root, spec);
  return typeof locator.first === "function" ? locator.first() : locator;
}

export async function findVisibleLocator(root, specs) {
  for (const spec of specs) {
    const locator = locatorFromSpec(root, spec);

    try {
      if (await locator.isVisible()) return { locator, spec };
    } catch {
      // A rerender can detach one fallback while another remains usable.
    }
  }

  return null;
}

export async function anyLocatorVisible(root, specs) {
  return Boolean(await findVisibleLocator(root, specs));
}

export async function anyLocatorVisibleOutsideTimeline(
  root,
  specs,
  { maximumCandidates = 8 } = {},
) {
  for (const spec of specs) {
    try {
      const collection = locatorCollectionFromSpec(root, spec);
      const count = Math.min(await collection.count(), maximumCandidates);
      for (let index = 0; index < count; index += 1) {
        const candidate = collection.nth(index);
        if (!(await candidate.isVisible())) continue;
        const outsideTimeline = await candidate.evaluate((node) =>
          !node.closest('article[data-testid="tweet"]'));
        if (outsideTimeline) return true;
      }
    } catch {
      // Detached or drifting candidates are not trusted as state evidence.
    }
  }
  return false;
}

/**
 * Searches bounded, visible system containers for text while explicitly
 * excluding anything rendered inside a timeline article. This prevents post
 * copy from impersonating X challenge or feed-error UI.
 */
export async function anyTextVisibleWithin(
  root,
  scopeSpecs,
  textSpecs,
  { maximumScopes = 8 } = {},
) {
  for (const scopeSpec of scopeSpecs) {
    try {
      const collection = locatorCollectionFromSpec(root, scopeSpec);
      const count = Math.min(await collection.count(), maximumScopes);

      for (let index = 0; index < count; index += 1) {
        const candidate = collection.nth(index);
        if (!(await candidate.isVisible())) continue;
        const outsideTimeline = await candidate.evaluate((node) =>
          !node.closest('article[data-testid="tweet"]'));
        if (!outsideTimeline) continue;
        if (await anyLocatorVisible(candidate, textSpecs)) return true;
      }
    } catch {
      // Detached or drifting system containers are not trusted as evidence.
    }
  }

  return false;
}
