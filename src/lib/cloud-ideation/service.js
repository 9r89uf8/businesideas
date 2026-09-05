import "server-only";

import { createSupabaseAdminClient } from "../supabase/admin.js";
import { embedTexts } from "../openai/embeddings.js";
import { createCloudIdeationService } from "./engine.js";

function service() {
  return createCloudIdeationService({ db: createSupabaseAdminClient(), embedTexts });
}

export async function createCloudIdeationRun(args) {
  return service().createCloudIdeationRun(args);
}

export async function advanceCloudIdeationRun(args) {
  return service().advanceCloudIdeationRun(args);
}

export async function failCloudIdeationRun(args) {
  return service().failCloudIdeationRun(args);
}
