import { startCloudComparison } from "../lib/cloud-ideation/dispatch.js";
import {
  advanceCloudIdeationRun,
  failCloudIdeationRun,
} from "../lib/cloud-ideation/service.js";

export async function launchCloudComparison(args) {
  "use step";
  return startCloudComparison(args);
}
launchCloudComparison.maxRetries = 3;

export async function advanceCloudComparison(args) {
  "use step";
  return advanceCloudIdeationRun(args);
}
advanceCloudComparison.maxRetries = 3;

export async function stopCloudComparison(args) {
  "use step";
  return failCloudIdeationRun(args);
}
stopCloudComparison.maxRetries = 3;
