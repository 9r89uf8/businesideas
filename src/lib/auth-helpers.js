export const OWNER_SESSION_STATUS = Object.freeze({
  OWNER: "owner",
  UNAUTHENTICATED: "unauthenticated",
  NON_OWNER: "non_owner",
});

export const MIN_OWNER_PASSWORD_LENGTH = 10;

export function classifyOwnerSession(userId, ownerId) {
  if (!ownerId) {
    throw new Error("OWNER_USER_ID is not configured.");
  }

  if (!userId) {
    return OWNER_SESSION_STATUS.UNAUTHENTICATED;
  }

  return userId === ownerId
    ? OWNER_SESSION_STATUS.OWNER
    : OWNER_SESSION_STATUS.NON_OWNER;
}

export function normalizeAuthEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeInternalRedirect(value, fallback = "/") {
  const candidate = typeof value === "string" ? value.trim() : "";

  if (
    !candidate ||
    candidate.length > 2_048 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.startsWith("/\\") ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return fallback;
  }

  try {
    const base = new URL("https://internal.invalid");
    const destination = new URL(candidate, base);
    if (destination.origin !== base.origin) return fallback;

    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return fallback;
  }
}

export function normalizePostLoginRedirect(value) {
  const destination = normalizeInternalRedirect(value);
  const pathname = new URL(destination, "https://internal.invalid").pathname;

  if (pathname === "/login" || pathname.startsWith("/auth/")) {
    return "/";
  }

  return destination;
}

export function buildLoginRedirectPath(destination) {
  const next = normalizePostLoginRedirect(destination);
  const params = new URLSearchParams({ next });
  return `/login?${params.toString()}`;
}

export function validatePasswordChange(password, confirmation) {
  if (typeof password !== "string" || !password) {
    return "Enter a new password.";
  }

  if (password.length < MIN_OWNER_PASSWORD_LENGTH) {
    return `Use at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`;
  }

  if (password !== confirmation) {
    return "The passwords do not match.";
  }

  return null;
}

export function buildRecoveryRedirectUrl(origin) {
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", "/settings#access");
  return callback.toString();
}
