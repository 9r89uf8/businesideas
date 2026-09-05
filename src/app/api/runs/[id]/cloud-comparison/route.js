import { requireOwnerForApi } from "@/lib/auth";
import { startCloudComparison } from "@/lib/cloud-ideation/dispatch";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(_request, { params }) {
  const identity = await requireOwnerForApi();
  if (!identity) return json({ error: "Unauthorized." }, 401);
  const { id: runId } = await params;
  if (!UUID.test(runId || "")) return json({ error: "Invalid run." }, 400);
  const ownerId = identity.ownerId;

  try {
    const db = createSupabaseAdminClient();
    const { data: run, error: runError } = await db.from("runs")
      .select("id, settings_snapshot").eq("id", runId).eq("owner_id", ownerId).maybeSingle();
    if (runError) throw new Error("Run lookup failed.");
    if (!run) return json({ error: "Run not found." }, 404);
    if (run.settings_snapshot?.ideation_provider === "chatgpt_cloud") {
      return json({ error: "This run already uses cloud research. A separate comparison cannot be started." }, 409);
    }

    const { data: posts, error } = await db.from("run_posts")
      .select("post_id, filter_decision, hydrated_context")
      .eq("owner_id", ownerId).eq("run_id", runId)
      .eq("selected_for_ai", true).order("search_position");
    if (error) throw new Error("Post lookup failed.");
    const survivorPostIds = (posts || []).filter((post) =>
      post.filter_decision === "keep" ||
      (post.filter_decision === "needs_context" && post.hydrated_context?.status === "resolved"),
    ).map((post) => post.post_id);
    if (!survivorPostIds.length) {
      return json({ error: "This run has no posts ready for cloud comparison." }, 409);
    }

    const comparison = await startCloudComparison({ runId, ownerId, survivorPostIds });
    return json({ id: comparison.id, status: comparison.status, phase: comparison.phase }, 202);
  } catch {
    return json({ error: "The cloud comparison could not be started. Its source posts may no longer be available." }, 500);
  }
}
