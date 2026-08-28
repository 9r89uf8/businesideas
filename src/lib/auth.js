import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function configuredOwnerId() {
  const ownerId = process.env.OWNER_USER_ID;

  if (!ownerId) {
    throw new Error("OWNER_USER_ID is not configured.");
  }

  return ownerId;
}

export const getOwnerIdentity = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;

  if (error || !userId || userId !== configuredOwnerId()) {
    return null;
  }

  return { ownerId: userId, supabase };
});

export async function requireOwner() {
  const identity = await getOwnerIdentity();

  if (!identity) {
    redirect("/login");
  }

  return identity;
}

export async function requireOwnerForApi() {
  return getOwnerIdentity();
}

export function isConfiguredOwner(userId) {
  return Boolean(userId) && userId === configuredOwnerId();
}
