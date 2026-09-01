import {
  anyLocatorVisible,
  anyLocatorVisibleOutsideTimeline,
  anyTextVisibleWithin,
  findVisibleLocator,
  X_LOCATORS,
} from "./locators.js";
import {
  isAllowedXHomeUrl,
  isAllowedXCombinedLoginUrl,
  isAllowedXLoginUrl,
  isAllowedXUrl,
  isExactXRootLanding,
} from "./navigation.js";

export const X_PAGE_STATES = Object.freeze({
  AUTHENTICATED: "AUTHENTICATED",
  COMBINED_LOGIN_REQUIRED: "COMBINED_LOGIN_REQUIRED",
  USE_PASSWORD_REQUIRED: "USE_PASSWORD_REQUIRED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  ROOT_LANDING: "ROOT_LANDING",
  USERNAME_REQUIRED: "USERNAME_REQUIRED",
  PASSWORD_REQUIRED: "PASSWORD_REQUIRED",
  CHALLENGE: "CHALLENGE",
  UNKNOWN: "UNKNOWN",
});

function urlIndicatesChallenge(value) {
  if (!isAllowedXUrl(value)) return false;

  const pathname = new URL(value).pathname.toLowerCase();
  return [
    "/account/access",
    "/i/flow/challenge",
    "/i/flow/verify",
    "/i/flow/account_access",
  ].some((prefix) => pathname.startsWith(prefix));
}

export async function detectXPageState(page) {
  if (urlIndicatesChallenge(page.url())) return X_PAGE_STATES.CHALLENGE;
  if (await anyLocatorVisible(page, X_LOCATORS.challengeHardStructural)) {
    return X_PAGE_STATES.CHALLENGE;
  }
  // X's approved passwordless prompt contains a one-time-code input, but also
  // offers this exact method switch. Recognize only that narrow escape hatch;
  // the collector never reads from or writes to the code input.
  if (
    isAllowedXCombinedLoginUrl(page.url()) &&
    await anyLocatorVisible(page, X_LOCATORS.loginUsePassword)
  ) {
    return X_PAGE_STATES.USE_PASSWORD_REQUIRED;
  }
  if (await anyLocatorVisible(page, X_LOCATORS.oneTimeCode)) {
    return X_PAGE_STATES.CHALLENGE;
  }
  if (
    isAllowedXUrl(page.url()) &&
    /^\/home\/?$/.test(new URL(page.url()).pathname) &&
    await anyLocatorVisibleOutsideTimeline(
      page,
      X_LOCATORS.blockingHomeOverlay,
    )
  ) {
    return X_PAGE_STATES.CHALLENGE;
  }
  if (
    isAllowedXLoginUrl(page.url()) &&
    await anyLocatorVisible(page, X_LOCATORS.challengeWorkflowText)
  ) {
    return X_PAGE_STATES.CHALLENGE;
  }
  // Prefer the authenticated Home surface over generic textbox/text
  // fallbacks so timeline content can never be mistaken for a login prompt.
  if (
    isAllowedXHomeUrl(page.url()) &&
    await anyLocatorVisible(page, X_LOCATORS.authenticated)
  ) {
    return X_PAGE_STATES.AUTHENTICATED;
  }

  if (isAllowedXCombinedLoginUrl(page.url())) {
    const form = await findVisibleLocator(page, X_LOCATORS.combinedLoginForm);
    if (form) {
      const identifierVisible = await anyLocatorVisible(
        form.locator,
        X_LOCATORS.combinedLoginIdentifier,
      );
      const passwordVisible = await anyLocatorVisible(
        form.locator,
        X_LOCATORS.combinedLoginPassword,
      );
      if (identifierVisible && passwordVisible) {
        return X_PAGE_STATES.COMBINED_LOGIN_REQUIRED;
      }
    }

    const passwordForm = await findVisibleLocator(
      page,
      X_LOCATORS.combinedLoginPasswordForm,
    );
    return passwordForm
      ? X_PAGE_STATES.PASSWORD_REQUIRED
      : X_PAGE_STATES.UNKNOWN;
  }

  if (
    isAllowedXUrl(page.url()) &&
    new URL(page.url()).pathname === "/i/jf/onboarding/web"
  ) {
    return X_PAGE_STATES.UNKNOWN;
  }

  if (isExactXRootLanding(page.url())) {
    return X_PAGE_STATES.ROOT_LANDING;
  }

  if (!isAllowedXLoginUrl(page.url())) {
    return X_PAGE_STATES.UNKNOWN;
  }

  if (await anyLocatorVisible(page, X_LOCATORS.password)) {
    return X_PAGE_STATES.PASSWORD_REQUIRED;
  }

  const identifierVisible = await anyLocatorVisible(
    page,
    X_LOCATORS.loginIdentifier,
  );
  if (
    identifierVisible &&
    await anyLocatorVisible(page, X_LOCATORS.usernamePrompt)
  ) {
    return X_PAGE_STATES.USERNAME_REQUIRED;
  }
  if (identifierVisible) return X_PAGE_STATES.LOGIN_REQUIRED;

  return X_PAGE_STATES.UNKNOWN;
}

export async function waitForXPageState(
  page,
  {
    acceptedStates,
    timeoutMs = 20_000,
    pollIntervalMs = 200,
    now = () => Date.now(),
    assertPermissionActive = () => {},
  },
) {
  const accepted = new Set(acceptedStates);
  const deadline = now() + timeoutMs;

  do {
    await assertPermissionActive();
    const state = await detectXPageState(page);
    if (accepted.has(state)) return state;
    await assertPermissionActive();
    await page.waitForTimeout(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
  } while (now() < deadline);

  return X_PAGE_STATES.UNKNOWN;
}

export async function feedHasVisibleError(page) {
  return anyTextVisibleWithin(
    page,
    X_LOCATORS.feedErrorContainers,
    X_LOCATORS.feedErrorText,
  );
}
