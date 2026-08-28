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
