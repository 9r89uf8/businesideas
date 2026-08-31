import { findVisibleLocator, X_LOCATORS } from "./locators.js";
import {
  isAllowedXCombinedLoginUrl,
  requireAllowedXWorkflowPage,
  requireXCombinedLoginPage,
  requireXHomePage,
  requireXLoginPage,
} from "./navigation.js";

export const X_READ_ONLY_ACTIONS = Object.freeze({
  FILL_LOGIN_IDENTIFIER: "fill-login-identifier",
  CLICK_LOGIN_NEXT: "click-login-next",
  FILL_LOGIN_USERNAME: "fill-login-username",
  FILL_LOGIN_PASSWORD: "fill-login-password",
  CLICK_LOGIN_SUBMIT: "click-login-submit",
  CLICK_FOR_YOU: "click-for-you",
  SCROLL_FEED: "scroll-feed",
});

const ALLOWED_ACTIONS = new Set(Object.values(X_READ_ONLY_ACTIONS));
const LOGIN_ACTIONS = new Set([
  X_READ_ONLY_ACTIONS.FILL_LOGIN_IDENTIFIER,
  X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT,
  X_READ_ONLY_ACTIONS.FILL_LOGIN_USERNAME,
  X_READ_ONLY_ACTIONS.FILL_LOGIN_PASSWORD,
  X_READ_ONLY_ACTIONS.CLICK_LOGIN_SUBMIT,
]);
const DYNAMIC_CONTROL_POLL_INTERVAL_MS = 200;
const DYNAMIC_CONTROL_MAX_POLLS = 26;

function selectorDrift(action) {
  const error = new Error(`The approved UI control for ${action} is unavailable.`);
  error.code = "SELECTOR_DRIFT";
  error.locator = action;
  return error;
}

async function requireVisible(page, specs, action) {
  const match = await findVisibleLocator(page, specs);
  if (!match) throw selectorDrift(action);
  return match.locator;
}

async function requireMaterializedCombinedSubmit(
  page,
  action,
  assertPermissionActive,
) {
  for (let poll = 0; poll < DYNAMIC_CONTROL_MAX_POLLS; poll += 1) {
    await assertPermissionActive();
    requireXCombinedLoginPage(page);
    const root = await combinedLoginForm(page, action);
    requireXCombinedLoginPage(page);
    const match = await findVisibleLocator(root, X_LOCATORS.combinedLoginSubmit);
    requireXCombinedLoginPage(page);
    if (match) return match.locator;
    if (poll + 1 < DYNAMIC_CONTROL_MAX_POLLS) {
      await page.waitForTimeout(DYNAMIC_CONTROL_POLL_INTERVAL_MS);
    }
  }
  throw selectorDrift(action);
}

async function combinedLoginForm(page, action) {
  requireXCombinedLoginPage(page);
  const form = await requireVisible(page, X_LOCATORS.combinedLoginForm, action);
  requireXCombinedLoginPage(page);
  return form;
}

/**
 * This switch is the collector's complete mutating UI-action surface. It has
 * no generic click/fill escape hatch and deliberately contains no timeline,
 * engagement, follow, bookmark, message, compose, or settings action.
 */
export async function performReadOnlyAction(
  page,
  action,
  value,
  { assertPermissionActive = () => {} } = {},
) {
  if (!ALLOWED_ACTIONS.has(action)) {
    const error = new Error("The requested browser action is not approved.");
    error.code = "ACTION_BLOCKED";
    throw error;
  }

  if (LOGIN_ACTIONS.has(action)) requireXLoginPage(page);
  else requireXHomePage(page);
  const combinedLoginAction =
    LOGIN_ACTIONS.has(action) && isAllowedXCombinedLoginUrl(page.url());

  switch (action) {
    case X_READ_ONLY_ACTIONS.FILL_LOGIN_IDENTIFIER: {
      const root = combinedLoginAction
        ? await combinedLoginForm(page, action)
        : page;
      const locator = await requireVisible(
        root,
        combinedLoginAction
          ? X_LOCATORS.combinedLoginIdentifier
          : X_LOCATORS.loginIdentifier,
        action,
      );
      await locator.fill(String(value));
      break;
    }
    case X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT: {
      const locator = await requireVisible(page, X_LOCATORS.loginNext, action);
      await locator.click();
      break;
    }
    case X_READ_ONLY_ACTIONS.FILL_LOGIN_USERNAME: {
      const locator = await requireVisible(
        page,
        X_LOCATORS.loginIdentifier,
        action,
      );
      await locator.fill(String(value));
      break;
    }
    case X_READ_ONLY_ACTIONS.FILL_LOGIN_PASSWORD: {
      const root = combinedLoginAction
        ? await combinedLoginForm(page, action)
        : page;
      const locator = await requireVisible(
        root,
        combinedLoginAction
          ? X_LOCATORS.combinedLoginPassword
          : X_LOCATORS.password,
        action,
      );
      await locator.fill(String(value));
      break;
    }
    case X_READ_ONLY_ACTIONS.CLICK_LOGIN_SUBMIT: {
      const locator = combinedLoginAction
        ? await requireMaterializedCombinedSubmit(
            page,
            action,
            assertPermissionActive,
          )
        : await requireVisible(page, X_LOCATORS.loginSubmit, action);
      await assertPermissionActive();
      if (combinedLoginAction) requireXCombinedLoginPage(page);
      else requireXLoginPage(page);
      await locator.click();
      break;
    }
    case X_READ_ONLY_ACTIONS.CLICK_FOR_YOU: {
      const locator = await requireVisible(page, X_LOCATORS.forYouTab, action);
      await locator.click();
      break;
    }
    case X_READ_ONLY_ACTIONS.SCROLL_FEED:
      await page.evaluate(() => {
        window.scrollBy({
          top: Math.round(window.innerHeight * 0.8),
          behavior: "smooth",
        });
      });
      break;
    default:
      throw new TypeError("Unhandled approved browser action.");
  }

  if (
    action === X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT ||
    action === X_READ_ONLY_ACTIONS.CLICK_LOGIN_SUBMIT
  ) {
    requireAllowedXWorkflowPage(page);
  } else if (LOGIN_ACTIONS.has(action)) {
    if (combinedLoginAction) requireXCombinedLoginPage(page);
    else requireXLoginPage(page);
  } else {
    requireXHomePage(page);
  }
}
