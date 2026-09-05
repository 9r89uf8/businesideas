import "server-only";

import { start } from "workflow/api";
import { cloudIdeation } from "../../workflows/cloud-ideation.js";
import { createSupabaseAdminClient } from "../supabase/admin.js";
import { createCloudIdeationRun, failCloudIdeationRun } from "./service.js";

const TERMINAL = new Set(["completed", "no_ideas", "failed"]);

async function closeFailedDispatch(runId, ownerId) {
  try {
    await failCloudIdeationRun({ runId, ownerId, message: "Cloud coordinator dispatch failed." });
  } catch {
    // Preserve the startup failure if recording it also fails. The caller can
    // retry without an unrelated cleanup error hiding the original problem.
  }
}

/** Dispatch the requested immutable cloud mode; primary replaces the Sol API stages. */
export async function startCloudComparison({ runId, ownerId, survivorPostIds, mode = "shadow" }) {
  const db = createSupabaseAdminClient();
  const { error: retentionError } = await db.rpc("purge_cloud_model_payloads", {
    p_owner_id: ownerId,
  });
  if (retentionError) throw new Error("Expired cloud comparison inputs could not be removed.");
  // Retention must succeed before inserting anything that needs a coordinator.
  await createCloudIdeationRun({ runId, ownerId, survivorPostIds, mode });
  let comparison;
  try {
    const { data, error } = await db
      .from("cloud_ideation_runs")
      .select("id, status, phase, workflow_run_id")
      .eq("id", runId)
      .eq("owner_id", ownerId)
      .single();
    if (error || !data) throw new Error("The cloud comparison could not be loaded.", { cause: error });
    comparison = data;
  } catch (error) {
    await closeFailedDispatch(runId, ownerId);
    throw error;
  }
  if (TERMINAL.has(comparison.status) || comparison.workflow_run_id) return comparison;

  // A transport retry may dispatch twice. Cloud checkpoints and unique job keys
  // are idempotent, and model claims/publication are atomic, so coordinators
  // cannot publish twice or consume jobs from the retained API pipeline.
  let workflow;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      workflow = await start(cloudIdeation, [{ runId, ownerId }]);
      break;
    } catch {
      // Cloud state transitions tolerate a lost startup acknowledgement.
    }
  }
  if (!workflow) {
    await closeFailedDispatch(runId, ownerId);
    throw new Error("The cloud coordinator could not be started.");
  }
  let dispatchRecorded = false;
  try {
    const { error: saveError } = await db
      .from("cloud_ideation_runs")
      .update({ workflow_run_id: workflow.runId })
      .eq("id", runId)
      .eq("owner_id", ownerId)
      .is("workflow_run_id", null);
    dispatchRecorded = !saveError;
  } catch {
    // A rejected transport promise also leaves the acknowledged workflow live.
  }
  // The workflow was acknowledged and is already running. Failure to save its
  // diagnostic ID must not turn successful dispatch into a failed comparison.
  return { ...comparison, workflow_run_id: workflow.runId, dispatch_recorded: dispatchRecorded };
}
