import Link from "next/link";
import { redirect } from "next/navigation";
import { getOwnerIdentity } from "@/lib/auth";
import { buildLoginRedirectPath } from "@/lib/auth-helpers";
import {
  hasSupportedOAuthScopes,
  normalizeAuthorizationId,
  normalizeOAuthRedirectUrl,
  splitOAuthScopes,
} from "@/lib/mcp/oauth";
import { approveAuthorization, denyAuthorization } from "./actions";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "This authorization request is invalid or expired.",
  request_unavailable: "The authorization request could not be loaded.",
  invalid_redirect: "The authorization client supplied an unsafe redirect.",
  request_not_allowed: "This authorization request is not allowed.",
  decision_failed: "The authorization decision could not be completed.",
});

function displayHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "Unknown destination";
  }
}

function ConsentFrame({ children }) {
  return (
    <main className="grid min-h-screen place-items-center px-5 py-12">
      <section className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-white/80 p-6 shadow-sm sm:p-8">
        <p className="eyebrow">Private connection</p>
        {children}
      </section>
    </main>
  );
}

function ConsentError({ code }) {
  return (
    <ConsentFrame>
      <h1 className="mt-3 text-2xl font-semibold tracking-[-0.035em]">
        Connection unavailable
      </h1>
      <p role="alert" className="mt-4 text-sm leading-6 text-[var(--ink-soft)]">
        {ERROR_MESSAGES[code] || "This authorization request cannot continue."}
      </p>
      <Link
        href="/"
        className="focus-ring mt-6 inline-flex rounded-lg border border-[var(--line)] bg-white px-4 py-2.5 text-sm font-bold"
      >
        Return to Signal Foundry
      </Link>
    </ConsentFrame>
  );
}

export default async function OAuthConsentPage({ searchParams }) {
  const query = await searchParams;
  const authorizationId = normalizeAuthorizationId(query?.authorization_id);
  const errorCode =
    typeof query?.error === "string" ? query.error : "invalid_request";

  if (!authorizationId) {
    return <ConsentError code={errorCode} />;
  }

  const returnPath = `/oauth/consent?${new URLSearchParams({
    authorization_id: authorizationId,
  }).toString()}`;
  const identity = await getOwnerIdentity();
  if (!identity) {
    redirect(buildLoginRedirectPath(returnPath));
  }

  const { data: details, error } =
    await identity.supabase.auth.oauth.getAuthorizationDetails(
      authorizationId,
    );

  if (error || !details) {
    return <ConsentError code="request_unavailable" />;
  }

  if ("redirect_url" in details) {
    const destination = normalizeOAuthRedirectUrl(details.redirect_url);
    if (!destination) return <ConsentError code="invalid_redirect" />;
    redirect(destination);
  }

  if (
    details.authorization_id !== authorizationId ||
    details.user?.id !== identity.ownerId ||
    !hasSupportedOAuthScopes(details.scope) ||
    !normalizeOAuthRedirectUrl(details.redirect_uri)
  ) {
    return <ConsentError code="request_not_allowed" />;
  }

  const scopes = splitOAuthScopes(details.scope);
  const notice = ERROR_MESSAGES[errorCode];
  const approve = approveAuthorization.bind(null, authorizationId);
  const deny = denyAuthorization.bind(null, authorizationId);

  return (
    <ConsentFrame>
      <h1 className="mt-3 text-2xl font-semibold tracking-[-0.035em]">
        Allow {details.client?.name || "this client"} to run research?
      </h1>
      <p className="mt-4 text-sm leading-6 text-[var(--ink-soft)]">
        Signal Foundry exposes only its three private research-job tools, and
        its application tables reject direct access from this OAuth client.
        The client also receives the standard identity fields listed below.
      </p>

      {notice && query?.error && (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-[var(--rose)]/35 bg-[var(--rose)]/8 px-4 py-3 text-sm text-[#7d3d36]"
        >
          {notice}
        </p>
      )}

      <dl className="mt-6 divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--paper)] px-4">
        <div className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr]">
          <dt className="text-xs font-bold text-[var(--ink-soft)]">Client</dt>
          <dd className="break-words text-sm font-semibold">
            {details.client?.name || "Unnamed client"}
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr]">
          <dt className="text-xs font-bold text-[var(--ink-soft)]">Website</dt>
          <dd className="break-words text-sm">
            {displayHost(details.client?.uri)}
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr]">
          <dt className="text-xs font-bold text-[var(--ink-soft)]">Returns to</dt>
          <dd className="break-words text-sm">
            {displayHost(details.redirect_uri)}
          </dd>
        </div>
        <div className="grid gap-1 py-3 sm:grid-cols-[8rem_1fr]">
          <dt className="text-xs font-bold text-[var(--ink-soft)]">Access</dt>
          <dd className="flex flex-wrap gap-2">
            {scopes.map((scope) => (
              <span
                key={scope}
                className="rounded-full border border-[var(--line)] bg-white px-2.5 py-1 font-mono text-xs"
              >
                {scope}
              </span>
            ))}
          </dd>
        </div>
      </dl>

      <p className="mt-5 text-xs leading-5 text-[var(--ink-soft)]">
        Approve only if you started this connection. Access remains restricted
        to your configured owner account and can be revoked in Supabase. Keep
        only the connected client you recognize.
      </p>

      <div className="mt-7 grid gap-3 sm:grid-cols-2">
        <form action={deny}>
          <button
            type="submit"
            className="focus-ring w-full rounded-xl border border-[var(--line)] bg-white px-4 py-3 text-sm font-bold"
          >
            Deny
          </button>
        </form>
        <form action={approve}>
          <button
            type="submit"
            className="focus-ring w-full rounded-xl bg-[var(--ink)] px-4 py-3 text-sm font-bold text-white"
          >
            Allow research access
          </button>
        </form>
      </div>
    </ConsentFrame>
  );
}
