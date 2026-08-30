const DEFAULT_MCP_RESOURCE_URL =
  "https://admins-projects-d500137d.vercel.app/mcp";

// Supabase returns granted OAuth scopes alongside the token response, but the
// access-token JWT itself does not contain a `scope` claim. Owner, client_id,
// issuer, expiration, role, and the exact resource audience are the enforced
// bearer-token boundary.
export const MCP_REQUIRED_SCOPES = Object.freeze([]);
export const MCP_REQUEST_MAX_BYTES = 1_250_000;

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function requireHttpsUrl(value, label) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a plain HTTPS URL.`);
  }

  return url;
}

export function getMcpResourceUrl(environment = process.env) {
  const configured = environment.MCP_RESOURCE_URL?.trim();
  const productionHostname =
    environment.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const fallback = productionHostname
    ? `https://${productionHostname}/mcp`
    : DEFAULT_MCP_RESOURCE_URL;
  const url = requireHttpsUrl(configured || fallback, "MCP_RESOURCE_URL");

  url.pathname = withoutTrailingSlash(url.pathname) || "/mcp";
  if (url.pathname !== "/mcp") {
    throw new Error("MCP_RESOURCE_URL must use the /mcp path.");
  }

  return url.toString();
}

export function getMcpTokenAudience(environment = process.env) {
  const configured = environment.MCP_TOKEN_AUDIENCE?.trim();
  if (!configured) return getMcpResourceUrl(environment);

  const url = requireHttpsUrl(configured, "MCP_TOKEN_AUDIENCE");
  url.pathname = withoutTrailingSlash(url.pathname) || "/mcp";
  if (url.pathname !== "/mcp") {
    throw new Error("MCP_TOKEN_AUDIENCE must use the /mcp path.");
  }

  return url.toString();
}

export function getSupabaseAuthIssuer(environment = process.env) {
  const value = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!value) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.");
  }

  const projectUrl = requireHttpsUrl(
    withoutTrailingSlash(value),
    "NEXT_PUBLIC_SUPABASE_URL",
  );
  return `${withoutTrailingSlash(projectUrl.toString())}/auth/v1`;
}

export function getSupabaseJwksUrl(environment = process.env) {
  const configured = environment.SUPABASE_JWKS_URL?.trim();
  if (configured) {
    return requireHttpsUrl(configured, "SUPABASE_JWKS_URL").toString();
  }

  return `${getSupabaseAuthIssuer(environment)}/.well-known/jwks.json`;
}

export function getMcpMetadataUrl(environment = process.env) {
  const resource = new URL(getMcpResourceUrl(environment));
  return `${resource.origin}/.well-known/oauth-protected-resource`;
}
