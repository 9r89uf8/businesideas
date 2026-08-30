import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildRecoveryRedirectUrl,
  buildLoginRedirectPath,
  classifyOwnerSession,
  MIN_OWNER_PASSWORD_LENGTH,
  normalizeAuthEmail,
  normalizeInternalRedirect,
  normalizePostLoginRedirect,
  OWNER_SESSION_STATUS,
  validatePasswordChange,
} from "../src/lib/auth-helpers.js";

test("owner sessions are distinguished from missing and non-owner sessions", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111";

  assert.equal(
    classifyOwnerSession(ownerId, ownerId),
    OWNER_SESSION_STATUS.OWNER,
  );
  assert.equal(
    classifyOwnerSession(null, ownerId),
    OWNER_SESSION_STATUS.UNAUTHENTICATED,
  );
  assert.equal(
    classifyOwnerSession("22222222-2222-4222-8222-222222222222", ownerId),
    OWNER_SESSION_STATUS.NON_OWNER,
  );
  assert.throws(
    () => classifyOwnerSession(ownerId, ""),
    /OWNER_USER_ID is not configured/,
  );
});

test("login email normalization is safe and predictable", () => {
  assert.equal(normalizeAuthEmail("  Owner@Example.COM "), "owner@example.com");
  assert.equal(normalizeAuthEmail(null), "");
});

test("password setup requires a matching useful-length password", () => {
  const validPassword = "correct horse battery staple";

  assert.equal(validatePasswordChange(validPassword, validPassword), null);
  assert.match(validatePasswordChange("", ""), /enter a new password/i);
  const shortPassword = "x".repeat(MIN_OWNER_PASSWORD_LENGTH - 1);
  assert.match(
    validatePasswordChange(shortPassword, shortPassword),
    new RegExp(`${MIN_OWNER_PASSWORD_LENGTH} characters`, "i"),
  );
  assert.match(
    validatePasswordChange(validPassword, `${validPassword}!`),
    /do not match/i,
  );
});

test("recovery links return the owner to the password section", () => {
  const redirect = new URL(
    buildRecoveryRedirectUrl("https://signal-foundry.example"),
  );

  assert.equal(redirect.origin, "https://signal-foundry.example");
  assert.equal(redirect.pathname, "/auth/callback");
  assert.equal(redirect.searchParams.get("next"), "/settings#access");
});

test("login return paths stay on the application origin", () => {
  assert.equal(
    normalizeInternalRedirect("/oauth/consent?authorization_id=request-123"),
    "/oauth/consent?authorization_id=request-123",
  );
  assert.equal(normalizeInternalRedirect("https://attacker.example"), "/");
  assert.equal(normalizeInternalRedirect("//attacker.example/path"), "/");
  assert.equal(normalizeInternalRedirect("/\\attacker.example/path"), "/");
  assert.equal(normalizePostLoginRedirect("/login?next=/login"), "/");
  assert.equal(normalizePostLoginRedirect("/auth/callback"), "/");

  const login = new URL(
    buildLoginRedirectPath(
      "/oauth/consent?authorization_id=request-123&source=codex",
    ),
    "https://signal-foundry.example",
  );
  assert.equal(login.pathname, "/login");
  assert.equal(
    login.searchParams.get("next"),
    "/oauth/consent?authorization_id=request-123&source=codex",
  );
});

test("auth forms preserve password-manager autocomplete contracts", async () => {
  const [loginSource, accessSource] = await Promise.all([
    readFile(new URL("../src/app/login/page.js", import.meta.url), "utf8"),
    readFile(
      new URL("../src/components/access-settings.jsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(loginSource, /signInWithPassword/);
  assert.match(loginSource, /autoComplete="username"/);
  assert.match(loginSource, /autoComplete="current-password"/);
  assert.match(loginSource, /signInWithOtp/);
  assert.match(accessSource, /updateUser/);
  assert.equal(
    accessSource.match(/autoComplete="new-password"/g)?.length,
    2,
  );
});

test("both the login handshake and route proxy clear non-owner sessions", async () => {
  const [ownerSessionRoute, proxySource] = await Promise.all([
    readFile(
      new URL(
        "../src/app/api/auth/owner-session/route.js",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../proxy.js", import.meta.url), "utf8"),
  ]);

  assert.match(ownerSessionRoute, /isConfiguredOwner\(userId\)/);
  assert.match(ownerSessionRoute, /signOut\(\{ scope: "local" \}\)/);
  assert.match(proxySource, /userId && !isOwner/);
  assert.match(proxySource, /signOut\(\{ scope: "local" \}\)/);
  assert.match(proxySource, /pathname === "\/mcp"/);
  assert.match(proxySource, /pathname === "\/oauth\/consent"/);
  assert.match(proxySource, /buildLoginRedirectPath\(destination\)/);
});
