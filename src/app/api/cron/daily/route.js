import { timingSafeEqual } from "node:crypto";
import {
  ActiveRunError,
  RUN_START_OUTCOMES,
  startRun,
} from "@/lib/runs/start-run";

export const runtime = "nodejs";

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function authorized(request, secret) {
  const supplied = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);

  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return json({ error: "Cron is not configured." }, 503);
  }
  if (!authorized(request, cronSecret)) {
    return json({ error: "Unauthorized." }, 401);
  }

  try {
    const run = await startRun({ trigger: "scheduled" });
    const status =
      run.outcome === RUN_START_OUTCOMES.ALREADY_FINISHED ? 200 : 202;
    return json(
      { id: run.id, status: run.status, outcome: run.outcome },
      status,
    );
  } catch (error) {
    if (error instanceof ActiveRunError) {
      return json({ error: "A research run is already active." }, 409);
    }

    return json({ error: "The scheduled run could not be started." }, 500);
  }
}
