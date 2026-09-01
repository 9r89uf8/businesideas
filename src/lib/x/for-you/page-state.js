import {
  anyLocatorVisible,
  anyLocatorVisibleOutsideTimeline,
  anyTextVisibleWithin,
  X_LOCATORS,
} from "./locators.js";
import { isAllowedXLoginUrl, isAllowedXUrl } from "./navigation.js";

export const X_PAGE_STATES = Object.freeze({
  AUTHENTICATED: "AUTHENTICATED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
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
  if (await anyLocatorVisible(page, X_LOCATORS.challengeStructural)) {
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
  if (await anyLocatorVisible(page, X_LOCATORS.authenticated)) {
    return X_PAGE_STATES.AUTHENTICATED;
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
