import { createMcpHandler, withMcpAuth } from "mcp-handler";
import {
  getMcpResourceUrl,
  MCP_REQUEST_MAX_BYTES,
  MCP_REQUIRED_SCOPES,
} from "@/lib/mcp/config";
import { verifyMcpBearerToken } from "@/lib/mcp/auth";
import { registerResearchTools } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcpHandler = createMcpHandler(
  (server) => {
    registerResearchTools(server);
  },
  {
    serverInfo: {
      name: "signal-foundry-research",
      version: "1.0.0",
    },
    instructions:
      "Claim at most one job, research only its supplied evidence, then submit one schema-valid result or report a bounded failure code.",
    maxSubscriptions: 0,
    verboseLogs: false,
  },
);

function payloadTooLargeResponse() {
  return Response.json(
    { error: "request_too_large" },
    {
      status: 413,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function sizeLimitedHandler(request) {
  if (request.method === "POST") {
    const declaredLength = request.headers.get("content-length");
    if (
      declaredLength &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MCP_REQUEST_MAX_BYTES)
    ) {
      return payloadTooLargeResponse();
    }

    try {
      const reader = request.clone().body?.getReader();
      let receivedBytes = 0;

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;

          if (receivedBytes > MCP_REQUEST_MAX_BYTES) {
            void reader.cancel();
            return payloadTooLargeResponse();
          }
        }
      }
    } catch {
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  }

  return mcpHandler(request);
}

const resourceUrl = getMcpResourceUrl();
const authenticatedHandler = withMcpAuth(
  sizeLimitedHandler,
  verifyMcpBearerToken,
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource",
    requiredScopes: MCP_REQUIRED_SCOPES,
    resourceUrl: new URL(resourceUrl).origin,
  },
);

export {
  authenticatedHandler as DELETE,
  authenticatedHandler as GET,
  authenticatedHandler as POST,
};
