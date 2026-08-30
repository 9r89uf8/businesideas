const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,511}$/;
export const SUPPORTED_OAUTH_SCOPES = Object.freeze([
  "openid",
  "email",
  "offline_access",
]);

export function normalizeAuthorizationId(value) {
  const authorizationId = typeof value === "string" ? value.trim() : "";
  return AUTHORIZATION_ID_PATTERN.test(authorizationId)
    ? authorizationId
    : null;
}

function parseSecureRedirect(value) {
  if (typeof value !== "string" || value.length > 4_096) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function normalizeOAuthRedirectUrl(value, registeredRedirect) {
  const destination = parseSecureRedirect(value);
  if (!destination) return null;

  if (registeredRedirect) {
    const registered = parseSecureRedirect(registeredRedirect);
    if (
      !registered ||
      destination.origin !== registered.origin ||
      destination.pathname !== registered.pathname
    ) {
      return null;
    }
  }

  return destination.toString();
}

export function splitOAuthScopes(value) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];

  return [
    ...new Set(
      values
        .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

export function hasSupportedOAuthScopes(value) {
  const scopes = splitOAuthScopes(value);
  return (
    SUPPORTED_OAUTH_SCOPES.every((scope) => scopes.includes(scope)) &&
    scopes.every((scope) => SUPPORTED_OAUTH_SCOPES.includes(scope))
  );
}
