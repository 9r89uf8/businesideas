import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMcpAuthInfo,
  parseOAuthScopes,
} from "../src/lib/mcp/auth-claims.js";
import {
  getMcpMetadataUrl,
  getMcpResourceUrl,
  getMcpTokenAudience,
  getSupabaseAuthIssuer,
  getSupabaseJwksUrl,
} from "../src/lib/mcp/config.js";
import {
  hasSupportedOAuthScopes,
  normalizeAuthorizationId,
  normalizeOAuthRedirectUrl,
  splitOAuthScopes,
} from "../src/lib/mcp/oauth.js";
import {
  canonicalResearchJson,
  hashResearchJson,
} from "../src/lib/research/canonical-json.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "https://signal-foundry.example/mcp";
const AUDIENCE = "https://worker.signal-foundry.example/mcp";

function claims(overrides = {}) {
  return {
    sub: OWNER_ID,
    role: "authenticated",
    client_id: "https://chatgpt.com/.well-known/oauth-client",
    aud: AUDIENCE,
    scope: "openid email",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    ...overrides,
  };
}

test("MCP OAuth claims bind one owner, client, and exact audience", () => {
  const expected = {
    ownerId: OWNER_ID,
    resourceUrl: RESOURCE,
    tokenAudience: AUDIENCE,
    requiredScopes: ["email"],
  };
  const auth = buildMcpAuthInfo(claims(), "private-token", expected);

  assert.equal(auth.clientId, claims().client_id);
  assert.equal(auth.resource.toString(), RESOURCE);
  assert.deepEqual(auth.scopes, ["openid", "email"]);

  const authWithoutJwtScope = buildMcpAuthInfo(
    claims({ scope: undefined }),
    "bearer",
    { ownerId: OWNER_ID, resourceUrl: RESOURCE, tokenAudience: AUDIENCE },
  );
  assert.ok(authWithoutJwtScope);
  assert.deepEqual(authWithoutJwtScope.scopes, []);
  assert.equal(auth.extra.ownerId, OWNER_ID);

  for (const invalid of [
    claims({ sub: "22222222-2222-4222-8222-222222222222" }),
    claims({ role: "anon" }),
    claims({ client_id: "" }),
    claims({ aud: "authenticated" }),
    claims({ scope: "openid" }),
    claims({ exp: 1 }),
  ]) {
    assert.equal(
      buildMcpAuthInfo(invalid, "private-token", expected),
      undefined,
    );
  }
  assert.equal(buildMcpAuthInfo(claims(), "", expected), undefined);
});

test("MCP resource and Supabase issuer URLs are derived deterministically", () => {
  const environment = {
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co/",
    MCP_RESOURCE_URL: "https://signal-foundry.example/mcp/",
    MCP_TOKEN_AUDIENCE: "https://worker.signal-foundry.example/mcp/",
  };

  assert.equal(getMcpResourceUrl(environment), RESOURCE);
  assert.equal(getMcpTokenAudience(environment), AUDIENCE);
  assert.equal(
    getMcpMetadataUrl(environment),
    "https://signal-foundry.example/.well-known/oauth-protected-resource",
  );
  assert.equal(
    getSupabaseAuthIssuer(environment),
    "https://project.supabase.co/auth/v1",
  );
  assert.equal(
    getSupabaseJwksUrl(environment),
    "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  );
  assert.throws(
    () =>
      getMcpResourceUrl({ MCP_RESOURCE_URL: "http://signal-foundry.example/mcp" }),
    /HTTPS/,
  );
});

test("OAuth consent accepts only the supported identity scopes and safe redirects", () => {
  assert.deepEqual(parseOAuthScopes(" email openid email "), ["email", "openid"]);
  assert.deepEqual(splitOAuthScopes("openid email openid"), ["openid", "email"]);
  assert.deepEqual(splitOAuthScopes(["openid", "profile", "openid"]), [
    "openid",
    "profile",
  ]);
  assert.equal(hasSupportedOAuthScopes("openid email"), false);
  assert.equal(
    hasSupportedOAuthScopes("openid email offline_access"),
    true,
  );
  assert.equal(
    hasSupportedOAuthScopes("openid profile email offline_access"),
    false,
  );
  assert.equal(hasSupportedOAuthScopes("openid custom email"), false);
  assert.equal(hasSupportedOAuthScopes("openid"), false);
  assert.equal(normalizeAuthorizationId("request-123"), "request-123");
  assert.equal(normalizeAuthorizationId("short"), null);
  assert.equal(
    normalizeOAuthRedirectUrl(
      "https://chatgpt.example/callback?code=one&state=two",
      "https://chatgpt.example/callback",
    ),
    "https://chatgpt.example/callback?code=one&state=two",
  );
  assert.equal(
    normalizeOAuthRedirectUrl(
      "https://attacker.example/callback?code=one",
      "https://chatgpt.example/callback",
    ),
    null,
  );
  assert.equal(normalizeOAuthRedirectUrl("javascript:alert(1)"), null);
});

test("research JSON hashes are stable across object key order", () => {
  const first = { schema_version: 1, assessment: { notes: "ok", score: 1 } };
  const second = { assessment: { score: 1, notes: "ok" }, schema_version: 1 };

  assert.equal(canonicalResearchJson(first), canonicalResearchJson(second));
  assert.equal(hashResearchJson(first), hashResearchJson(second));
});
