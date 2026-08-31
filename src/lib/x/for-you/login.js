import {
  performReadOnlyAction,
  X_READ_ONLY_ACTIONS,
} from "./action-policy.js";
import {
  detectXPageState,
  waitForXPageState,
  X_PAGE_STATES,
} from "./page-state.js";
import { findVisibleLocator, X_LOCATORS } from "./locators.js";
import {
  isAllowedXUrl,
  requireAllowedXPage,
  requireXHomePage,
} from "./navigation.js";

const HOME_URL = "https://x.com/home";

function requiredCredential(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function resolveXLoginCredentials(env = process.env) {
  return Object.freeze({
    email: requiredCredential(env.X_LOGIN_EMAIL) || requiredCredential(env.x_email),
    username: requiredCredential(env.X_LOGIN_USERNAME),
    password:
      requiredCredential(env.X_LOGIN_PASSWORD) || requiredCredential(env.x_password),
  });
}

export async function requireAuthenticatedAccount(page, expectedAccount) {
  requireXHomePage(page);
  if (!/^@[A-Za-z0-9_]{1,15}$/.test(expectedAccount || "")) {
    throw authenticationError(
      "The authenticated X account could not be verified.",
      "AUTH_ACCOUNT_UNVERIFIED",
    );
  }

  const match = await findVisibleLocator(page, X_LOCATORS.authenticatedAccount);
  if (!match) {
    throw authenticationError(
      "The authenticated X account could not be verified.",
      "AUTH_ACCOUNT_UNVERIFIED",
    );
  }

  let href = null;
  try {
    href = await match.locator.getAttribute("href");
  } catch {
    // Missing or drifting profile identity fails closed below.
  }

  const handles = new Map();
  if (typeof href === "string") {
    try {
      const accountUrl = new URL(href, "https://x.com");
      const pathMatch = isAllowedXUrl(accountUrl.href) && accountUrl.pathname.match(
        /^\/([A-Za-z0-9_]{1,15})\/?$/,
      );
      if (pathMatch) handles.set(pathMatch[1].toLowerCase(), pathMatch[1]);
    } catch {
      // Malformed account hrefs fail closed below.
    }
  }

  const expected = expectedAccount.slice(1).toLowerCase();
  if (handles.size !== 1) {
    throw authenticationError(
      "The authenticated X account could not be verified.",
      "AUTH_ACCOUNT_UNVERIFIED",
    );
  }
  const [[actual, displayHandle]] = handles;
  if (actual !== expected) {
    throw authenticationError(
      "The authenticated X account does not match the approved account.",
      "AUTH_ACCOUNT_MISMATCH",
    );
  }
  return `@${displayHandle}`;
}

function authenticationError(message, code = "AUTH_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function waitForManualChallenge(
  page,
  { interactiveChallenges, manualActionTimeoutMs, assertPermissionActive, log },
) {
  log("MANUAL_ACTION_REQUIRED", {
    mode: interactiveChallenges ? "interactive" : "unattended",
  });

  if (!interactiveChallenges) {
    throw authenticationError(
      "X requires manual account verification.",
      "MANUAL_ACTION_REQUIRED",
    );
  }

  const state = await waitForXPageState(page, {
    acceptedStates: [X_PAGE_STATES.AUTHENTICATED],
    timeoutMs: manualActionTimeoutMs,
    assertPermissionActive,
  });
  assertPermissionActive();

  if (state !== X_PAGE_STATES.AUTHENTICATED) {
    throw authenticationError(
      "Manual X verification did not finish before the bounded timeout.",
      "MANUAL_ACTION_REQUIRED",
    );
  }
}

async function requirePasswordStep(page, options, initialState = null) {
  let state = initialState;
  if (!state) {
    state = await waitForXPageState(page, {
      acceptedStates: [
        X_PAGE_STATES.PASSWORD_REQUIRED,
        X_PAGE_STATES.USERNAME_REQUIRED,
        X_PAGE_STATES.AUTHENTICATED,
        X_PAGE_STATES.CHALLENGE,
      ],
      timeoutMs: options.stateTimeoutMs,
      assertPermissionActive: options.assertPermissionActive,
    });
  }

  if (state === X_PAGE_STATES.CHALLENGE) {
    await waitForManualChallenge(page, options);
    return X_PAGE_STATES.AUTHENTICATED;
  }

  if (state === X_PAGE_STATES.USERNAME_REQUIRED) {
    if (!options.credentials.username) {
      throw authenticationError(
        "X requested a username confirmation, but no username is configured.",
      );
    }

    options.assertPermissionActive();
    await performReadOnlyAction(
      page,
      X_READ_ONLY_ACTIONS.FILL_LOGIN_USERNAME,
      options.credentials.username.replace(/^@/, ""),
    );
    options.assertPermissionActive();
    await performReadOnlyAction(page, X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT);
    state = await waitForXPageState(page, {
      acceptedStates: [
        X_PAGE_STATES.PASSWORD_REQUIRED,
        X_PAGE_STATES.AUTHENTICATED,
        X_PAGE_STATES.CHALLENGE,
      ],
      timeoutMs: options.stateTimeoutMs,
      assertPermissionActive: options.assertPermissionActive,
    });
  }

  if (state === X_PAGE_STATES.CHALLENGE) {
    await waitForManualChallenge(page, options);
    return X_PAGE_STATES.AUTHENTICATED;
  }

  return state;
}

export async function ensureXAuthenticated(
  page,
  {
    env = process.env,
    interactiveChallenges = false,
    manualActionTimeoutMs = 300_000,
    stateTimeoutMs = 20_000,
    assertPermissionActive = () => {},
    log = () => {},
  } = {},
) {
  assertPermissionActive();
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  requireAllowedXPage(page);

  let state = await waitForXPageState(page, {
    acceptedStates: [
      X_PAGE_STATES.AUTHENTICATED,
      X_PAGE_STATES.LOGIN_REQUIRED,
      X_PAGE_STATES.USERNAME_REQUIRED,
      X_PAGE_STATES.PASSWORD_REQUIRED,
      X_PAGE_STATES.CHALLENGE,
    ],
    timeoutMs: stateTimeoutMs,
    assertPermissionActive,
  });

  if (state === X_PAGE_STATES.AUTHENTICATED) {
    log("AUTH_SESSION_REUSED");
    return "existing-session";
  }
  if (state === X_PAGE_STATES.CHALLENGE) {
    await waitForManualChallenge(page, {
      interactiveChallenges,
      manualActionTimeoutMs,
      stateTimeoutMs,
      assertPermissionActive,
      log,
    });
    log("AUTH_LOGIN_SUCCEEDED", { method: "manual" });
    return "manual";
  }

  const credentials = resolveXLoginCredentials(env);
  if (!credentials.email || !credentials.password) {
    throw authenticationError("X login credentials are unavailable.");
  }

  log("AUTH_LOGIN_STARTED");

  if (state === X_PAGE_STATES.LOGIN_REQUIRED) {
    assertPermissionActive();
    await performReadOnlyAction(
      page,
      X_READ_ONLY_ACTIONS.FILL_LOGIN_IDENTIFIER,
      credentials.email,
    );
    assertPermissionActive();
    await performReadOnlyAction(page, X_READ_ONLY_ACTIONS.CLICK_LOGIN_NEXT);
    state = await requirePasswordStep(page, {
      credentials,
      interactiveChallenges,
      manualActionTimeoutMs,
      stateTimeoutMs,
      assertPermissionActive,
      log,
    });
  } else if (state === X_PAGE_STATES.USERNAME_REQUIRED) {
    // A persistent profile can resume directly at X's account-confirmation
    // step. Treat that as a username prompt, never as the initial email form.
    state = await requirePasswordStep(page, {
      credentials,
      interactiveChallenges,
      manualActionTimeoutMs,
      stateTimeoutMs,
      assertPermissionActive,
      log,
    }, state);
  }

  if (state === X_PAGE_STATES.AUTHENTICATED) {
    log("AUTH_LOGIN_SUCCEEDED", { method: "credentials" });
    return "credentials";
  }
  if (state !== X_PAGE_STATES.PASSWORD_REQUIRED) {
    throw authenticationError("X login did not reach the password step.");
  }

  assertPermissionActive();
  await performReadOnlyAction(
    page,
    X_READ_ONLY_ACTIONS.FILL_LOGIN_PASSWORD,
    credentials.password,
  );
  assertPermissionActive();
  await performReadOnlyAction(page, X_READ_ONLY_ACTIONS.CLICK_LOGIN_SUBMIT);

  state = await waitForXPageState(page, {
    acceptedStates: [
      X_PAGE_STATES.AUTHENTICATED,
      X_PAGE_STATES.CHALLENGE,
    ],
    timeoutMs: stateTimeoutMs,
    assertPermissionActive,
  });

  if (state === X_PAGE_STATES.CHALLENGE) {
    await waitForManualChallenge(page, {
      interactiveChallenges,
      manualActionTimeoutMs,
      stateTimeoutMs,
      assertPermissionActive,
      log,
    });
    log("AUTH_LOGIN_SUCCEEDED", { method: "manual" });
    return "manual";
  }
  if (state !== X_PAGE_STATES.AUTHENTICATED) {
    log("AUTH_FAILED");
    throw authenticationError("X rejected the single permitted login attempt.");
  }

  requireXHomePage(page);
  if (await detectXPageState(page) !== X_PAGE_STATES.AUTHENTICATED) {
    throw authenticationError("X authentication could not be confirmed.");
  }

  log("AUTH_LOGIN_SUCCEEDED", { method: "credentials" });
  return "credentials";
}
