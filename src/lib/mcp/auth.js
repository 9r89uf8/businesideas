import "server-only";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { buildMcpAuthInfo } from "@/lib/mcp/auth-claims";
import {
  getMcpResourceUrl,
  getMcpTokenAudience,
  getSupabaseAuthIssuer,
  getSupabaseJwksUrl,
  MCP_REQUIRED_SCOPES,
} from "@/lib/mcp/config";

let cachedJwksUrl;
let cachedJwks;

function remoteJwks(url) {
  if (!cachedJwks || cachedJwksUrl !== url) {
    cachedJwksUrl = url;
    cachedJwks = createRemoteJWKSet(new URL(url));
  }

  return cachedJwks;
}

export async function verifyMcpBearerToken(_request, bearerToken) {
  if (typeof bearerToken !== "string" || !bearerToken.trim()) {
    return undefined;
  }

  try {
    const ownerId = process.env.OWNER_USER_ID?.trim();
    const resourceUrl = getMcpResourceUrl();
    const tokenAudience = getMcpTokenAudience();
    if (!ownerId) return undefined;

    const { payload } = await jwtVerify(
      bearerToken,
      remoteJwks(getSupabaseJwksUrl()),
      {
        issuer: getSupabaseAuthIssuer(),
        audience: tokenAudience,
        algorithms: ["RS256", "ES256"],
      },
    );

    return buildMcpAuthInfo(payload, bearerToken, {
      ownerId,
      resourceUrl,
      tokenAudience,
      requiredScopes: MCP_REQUIRED_SCOPES,
    });
  } catch {
    // Authentication failures are intentionally indistinguishable and never
    // include the bearer token or JWT provider details in logs or responses.
    return undefined;
  }
}
