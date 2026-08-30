function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseOAuthScopes(value) {
  const scopes = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];

  return [
    ...new Set(scopes.map(cleanString).filter(Boolean)),
  ];
}

function audienceIncludes(audience, resourceUrl) {
  if (typeof audience === "string") {
    return audience === resourceUrl;
  }

  return Array.isArray(audience) && audience.includes(resourceUrl);
}

export function buildMcpAuthInfo(
  claims,
  bearerToken,
  { ownerId, resourceUrl, tokenAudience = resourceUrl, requiredScopes = [] },
) {
  const subject = cleanString(claims?.sub);
  const clientId = cleanString(claims?.client_id);
  const role = cleanString(claims?.role);
  const token = cleanString(bearerToken);
  const scopes = parseOAuthScopes(claims?.scope ?? claims?.scopes);

  if (
    !token ||
    !ownerId ||
    subject !== ownerId ||
    role !== "authenticated" ||
    !clientId ||
    clientId.length > 2_048 ||
    !audienceIncludes(claims?.aud, tokenAudience) ||
    requiredScopes.some((scope) => !scopes.includes(scope)) ||
    !Number.isFinite(claims?.exp) ||
    claims.exp <= Math.floor(Date.now() / 1_000)
  ) {
    return undefined;
  }

  return {
    token,
    clientId,
    scopes,
    expiresAt: claims.exp,
    resource: new URL(resourceUrl),
    extra: { ownerId: subject },
  };
}
