import { requireOwnerForApi } from "@/lib/auth";
import { ActiveRunError, startRun } from "@/lib/runs/start-run";

export const runtime = "nodejs";

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST() {
  const identity = await requireOwnerForApi();
  if (!identity) {
    return json({ error: "Unauthorized." }, 401);
  }

  try {
    const run = await startRun({
      ownerId: identity.ownerId,
      trigger: "manual",
    });

    return json(
      {
        id: run.id,
        status: run.status,
        stage: run.stage,
        outcome: run.outcome,
      },
      202,
    );
  } catch (error) {
    if (error instanceof ActiveRunError) {
      return json({ error: "A research run is already active." }, 409);
    }

    return json({ error: "The research run could not be started." }, 500);
  }
}
