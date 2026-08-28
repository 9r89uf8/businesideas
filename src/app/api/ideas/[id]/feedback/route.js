import { FEEDBACK_REASONS, IDEA_STATUSES } from "@/lib/config";
import { requireOwnerForApi } from "@/lib/auth";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FEEDBACK_NOTE_LENGTH = 1_000;

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function validateFeedbackPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Feedback must be a JSON object." };
  }

  if (!IDEA_STATUSES.includes(value.status)) {
    return { error: "Invalid idea status." };
  }

  let reason = null;
  if (value.feedback_reason !== undefined && value.feedback_reason !== null) {
    if (typeof value.feedback_reason !== "string") {
      return { error: "Invalid feedback reason." };
    }

    reason = value.feedback_reason.trim() || null;
    if (reason && !FEEDBACK_REASONS.includes(reason)) {
      return { error: "Invalid feedback reason." };
    }
  }

  if (value.status === "rejected" && !reason) {
    return { error: "A reason is required when rejecting an idea." };
  }

  let note = null;
  if (value.feedback_note !== undefined && value.feedback_note !== null) {
    if (typeof value.feedback_note !== "string") {
      return { error: "Feedback note must be text." };
    }
    if (value.feedback_note.length > MAX_FEEDBACK_NOTE_LENGTH) {
      return {
        error: "Feedback note must be 1,000 characters or fewer.",
      };
    }

    note = value.feedback_note.trim() || null;
  }

  return {
    data: {
      status: value.status,
      feedback_reason: reason,
      feedback_note: note,
    },
  };
}

export async function POST(request, { params }) {
  const identity = await requireOwnerForApi();
  if (!identity) {
    return json({ error: "Unauthorized." }, 401);
  }

  const { id } = await params;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
    return json({ error: "Idea not found." }, 404);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const validation = validateFeedbackPayload(body);
  if (validation.error) {
    return json({ error: validation.error }, 400);
  }

  const { data, error } = await identity.supabase
    .from("ideas")
    .update({
      ...validation.data,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("owner_id", identity.ownerId)
    .select("id, status, feedback_reason, feedback_note")
    .maybeSingle();

  if (error) {
    return json({ error: "Feedback could not be saved." }, 500);
  }
  if (!data) {
    return json({ error: "Idea not found." }, 404);
  }

  return json(data, 200);
}
