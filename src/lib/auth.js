import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { classifyOwnerSession, OWNER_SESSION_STATUS } from "@/lib/auth-helpers";
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

  if (
    error ||
    classifyOwnerSession(userId, configuredOwnerId()) !==
      OWNER_SESSION_STATUS.OWNER
  ) {
    return null;
  }

  return {
    ownerId: userId,
    ownerEmail:
      typeof data?.claims?.email === "string"
        ? data.claims.email
        : process.env.OWNER_EMAIL || "",
    supabase,
  };
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
  return (
    classifyOwnerSession(userId, configuredOwnerId()) ===
    OWNER_SESSION_STATUS.OWNER
  );
}
