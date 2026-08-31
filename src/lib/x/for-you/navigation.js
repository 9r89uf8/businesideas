const ALLOWED_X_HOSTNAMES = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
]);
const ALLOWED_WORKFLOW_PATHS = Object.freeze([
  /^\/home\/?$/,
  /^\/login\/?$/,
  /^\/i\/flow\/login(?:\/|$)/,
  /^\/account\/access(?:\/|$)/,
  /^\/i\/flow\/(?:challenge|verify|account_access)(?:\/|$)/,
]);

export function isAllowedXUrl(value, { allowBlank = false } = {}) {
  if (allowBlank && value === "about:blank") return true;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      ALLOWED_X_HOSTNAMES.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isAllowedXWorkflowUrl(value) {
  if (!isAllowedXUrl(value)) return false;
  const { pathname } = new URL(value);
  return ALLOWED_WORKFLOW_PATHS.some((pattern) => pattern.test(pathname));
}

export function isAllowedXLoginUrl(value) {
  if (!isAllowedXUrl(value)) return false;
  const { pathname } = new URL(value);
  return /^\/login\/?$/.test(pathname) || /^\/i\/flow\/login(?:\/|$)/.test(pathname);
}

export function requireAllowedXPage(page) {
  const currentUrl = page.url();

  if (!isAllowedXUrl(currentUrl)) {
    const error = new Error("The collector left the approved X web origin.");
    error.code = "NAVIGATION_BLOCKED";
    throw error;
  }

  return currentUrl;
}

export function requireAllowedXWorkflowPage(page) {
  const currentUrl = page.url();
  if (!isAllowedXWorkflowUrl(currentUrl)) {
    const error = new Error("The collector left the approved X web workflow.");
    error.code = "NAVIGATION_BLOCKED";
    throw error;
  }
  return currentUrl;
}

export function requireXLoginPage(page) {
  const currentUrl = page.url();
  if (!isAllowedXLoginUrl(currentUrl)) {
    const error = new Error("The collector is not on the approved X login flow.");
    error.code = "NAVIGATION_BLOCKED";
    throw error;
  }
  return currentUrl;
}

export function requireXHomePage(page) {
  const currentUrl = requireAllowedXPage(page);
  const { pathname } = new URL(currentUrl);
  if (!/^\/home\/?$/.test(pathname)) {
    const error = new Error("The collector is not on the approved X Home page.");
    error.code = "NAVIGATION_BLOCKED";
    throw error;
  }
  return currentUrl;
}

export function sanitizePageUrl(value) {
  if (!isAllowedXUrl(value)) return "[blocked]";

  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

export async function installNavigationGuard(
  page,
  { browserContext = page.context?.() } = {},
) {
  if (!browserContext || typeof browserContext.route !== "function") {
    throw new TypeError("An X browser context is required for navigation safety.");
  }
  let blockedNavigation = null;
  let enteredWorkflow = isAllowedXWorkflowUrl(page.url());

  await browserContext.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) {
      await route.continue();
      return;
    }

    let frame;
    let requestPage;
    try {
      // Playwright documents that frame() can throw for a popup's first
      // navigation, before its Frame exists. That is precisely the request we
      // must not let escape the context-wide guard, so uncertainty is blocked.
      frame = request.frame();
      requestPage = frame.page();
    } catch {
      blockedNavigation = "[unresolved-navigation]";
      await route.abort("blockedbyclient");
      return;
    }

    const isMainFrameNavigation = frame === requestPage.mainFrame();
    const isUnexpectedPage = requestPage !== page;

    if (
      isMainFrameNavigation &&
      (isUnexpectedPage || !isAllowedXWorkflowUrl(request.url()))
    ) {
      blockedNavigation = sanitizePageUrl(request.url());
      await route.abort("blockedbyclient");
      return;
    }

    if (isMainFrameNavigation && requestPage === page) {
      enteredWorkflow = true;
    }

    await route.continue();
  });

  page.on("popup", (popup) => {
    blockedNavigation = "[popup]";
    void popup.close().catch(() => {});
  });

  return Object.freeze({
    assertSafe() {
      if (blockedNavigation !== null) {
        const error = new Error("An external top-level navigation was blocked.");
        error.code = "NAVIGATION_BLOCKED";
        throw error;
      }

      if (!enteredWorkflow && page.url() === "about:blank") return true;
      requireAllowedXWorkflowPage(page);
      return true;
    },
  });
}
