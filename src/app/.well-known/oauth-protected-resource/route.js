import {
  generateProtectedResourceMetadata,
  metadataCorsOptionsRequestHandler,
} from "mcp-handler";
import {
  getMcpResourceUrl,
  getSupabaseAuthIssuer,
} from "@/lib/mcp/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [getSupabaseAuthIssuer()],
    resourceUrl: getMcpResourceUrl(),
    additionalMetadata: {
      scopes_supported: ["openid", "email", "offline_access"],
    },
  });

  return Response.json(metadata, {
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
