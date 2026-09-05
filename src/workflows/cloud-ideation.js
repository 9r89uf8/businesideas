import { sleep } from "workflow";
import {
  advanceCloudComparison,
  stopCloudComparison,
} from "./cloud-ideation-steps.js";

const TERMINAL = new Set(["completed", "no_ideas", "failed"]);

export async function cloudIdeation({ runId, ownerId }) {
  "use workflow";

  // The scheduled cloud model writes only leased queue results. This trusted
  // coordinator validates them and advances the saved primary/comparison mode.
  for (let poll = 0; poll < 1440; poll += 1) {
    let state;
    try {
      state = await advanceCloudComparison({ runId, ownerId });
    } catch {
      await stopCloudComparison({
        runId,
        ownerId,
        message: "The cloud ideation could not be processed after retries.",
      });
      return { status: "failed", runId };
    }
    if (TERMINAL.has(state.status)) return state;
    await sleep("1m");
  }

  await stopCloudComparison({
    runId,
    ownerId,
    message: "Cloud ideation exceeded its 24-hour deadline.",
  });
  return { status: "failed", runId };
}
