import {
  performReadOnlyAction,
  X_READ_ONLY_ACTIONS,
} from "./action-policy.js";
import { findVisibleLocator, X_LOCATORS } from "./locators.js";
import { requireXHomePage } from "./navigation.js";

function selectorDrift(message, locator) {
  const error = new Error(message);
  error.code = "SELECTOR_DRIFT";
  error.locator = locator;
  return error;
}

export async function assertForYouSelected(
  page,
  { assertPermissionActive = () => {} } = {},
) {
  assertPermissionActive();
  requireXHomePage(page);
  const match = await findVisibleLocator(page, X_LOCATORS.forYouTab);
  assertPermissionActive();
  if (!match) {
    throw selectorDrift(
      'The English-language "For you" tab could not be located.',
      "for-you-tab",
    );
  }
  const selected = await match.locator.getAttribute("aria-selected");
  assertPermissionActive();
  if (selected !== "true") {
    throw selectorDrift(
      'X did not confirm that the "For you" tab is selected.',
      "for-you-tab[aria-selected=true]",
    );
  }
  return true;
}

export async function selectForYouFeed(
  page,
  {
    timeoutMs = 10_000,
    assertPermissionActive = () => {},
    log = () => {},
  } = {},
) {
  assertPermissionActive();
  requireXHomePage(page);
  const match = await findVisibleLocator(page, X_LOCATORS.forYouTab);

  if (!match) {
    throw selectorDrift(
      'The English-language "For you" tab could not be located.',
      "for-you-tab",
    );
  }

  if ((await match.locator.getAttribute("aria-selected")) !== "true") {
    assertPermissionActive();
    await performReadOnlyAction(page, X_READ_ONLY_ACTIONS.CLICK_FOR_YOU);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertPermissionActive();
    try {
      await assertForYouSelected(page, { assertPermissionActive });
      log("FOR_YOU_SELECTED");
      return;
    } catch (error) {
      if (error?.code !== "SELECTOR_DRIFT") throw error;
    }
    await page.waitForTimeout(150);
  }

  throw selectorDrift(
    'X did not confirm that the "For you" tab is selected.',
    "for-you-tab[aria-selected=true]",
  );
}
