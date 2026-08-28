import { requireOwnerForApi } from "@/lib/auth";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(_request, { params }) {
  const identity = await requireOwnerForApi();
  if (!identity) {
    return json({ error: "Unauthorized." }, 401);
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return json({ error: "Run not found." }, 404);
  }

  const { data, error } = await identity.supabase
    .from("runs")
    .select("id, status, stage, counts, error_message")
    .eq("id", id)
    .eq("owner_id", identity.ownerId)
    .maybeSingle();

  if (error) {
    return json({ error: "The run status could not be loaded." }, 500);
  }
  if (!data) {
    return json({ error: "Run not found." }, 404);
  }

  return json(
    {
      id: data.id,
      status: data.status,
      stage: data.stage,
      counts: data.counts,
      error_message: data.error_message,
    },
    200,
  );
}
