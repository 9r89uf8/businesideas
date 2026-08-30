"use server";

import { redirect } from "next/navigation";
import { getOwnerIdentity } from "@/lib/auth";
import { buildLoginRedirectPath } from "@/lib/auth-helpers";
import {
  hasSupportedOAuthScopes,
  normalizeAuthorizationId,
  normalizeOAuthRedirectUrl,
} from "@/lib/mcp/oauth";

function consentPath(authorizationId, error) {
  const params = new URLSearchParams();
  if (authorizationId) params.set("authorization_id", authorizationId);
  if (error) params.set("error", error);
  return `/oauth/consent?${params.toString()}`;
}

async function decideAuthorization(authorizationIdValue, decision) {
  const authorizationId = normalizeAuthorizationId(authorizationIdValue);
  if (!authorizationId) {
    redirect(consentPath(null, "invalid_request"));
  }

  const returnPath = consentPath(authorizationId);
  const identity = await getOwnerIdentity();
  if (!identity) {
    redirect(buildLoginRedirectPath(returnPath));
  }

  const { data: details, error: detailsError } =
    await identity.supabase.auth.oauth.getAuthorizationDetails(
      authorizationId,
    );

  if (detailsError || !details) {
    redirect(consentPath(authorizationId, "request_unavailable"));
  }

  if ("redirect_url" in details) {
    const existingRedirect = normalizeOAuthRedirectUrl(details.redirect_url);
    if (!existingRedirect) {
      redirect(consentPath(authorizationId, "invalid_redirect"));
    }
    redirect(existingRedirect);
  }

  if (
    details.authorization_id !== authorizationId ||
    details.user?.id !== identity.ownerId ||
    !hasSupportedOAuthScopes(details.scope) ||
    !normalizeOAuthRedirectUrl(details.redirect_uri)
  ) {
    redirect(consentPath(authorizationId, "request_not_allowed"));
  }

  const options = { skipBrowserRedirect: true };
  const { data, error } =
    decision === "approve"
      ? await identity.supabase.auth.oauth.approveAuthorization(
          authorizationId,
          options,
        )
      : await identity.supabase.auth.oauth.denyAuthorization(
          authorizationId,
          options,
        );

  const destination = normalizeOAuthRedirectUrl(
    data?.redirect_url,
    details.redirect_uri,
  );
  if (error || !destination) {
    redirect(consentPath(authorizationId, "decision_failed"));
  }

  redirect(destination);
}

export async function approveAuthorization(authorizationId) {
  return decideAuthorization(authorizationId, "approve");
}

export async function denyAuthorization(authorizationId) {
  return decideAuthorization(authorizationId, "deny");
}
