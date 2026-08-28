"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildRecoveryRedirectUrl,
  normalizeAuthEmail,
} from "@/lib/auth-helpers";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const EMPTY_STATE = { status: "idle", message: "" };

export default function LoginPage() {
  const emailInputRef = useRef(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [state, setState] = useState(EMPTY_STATE);

  useEffect(() => {
    const error = new URL(window.location.href).searchParams.get("error");
    if (error) {
      setRecoveryOpen(true);
      setState({
        status: "error",
        message: "That sign-in link could not be verified. Request a fresh link.",
      });
    }
  }, []);

  async function signInWithPassword(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const normalizedEmail = normalizeAuthEmail(formData.get("email"));
    const submittedPassword = formData.get("password");

    if (
      !normalizedEmail ||
      typeof submittedPassword !== "string" ||
      !submittedPassword
    ) {
      setState({
        status: "error",
        message: "Enter the owner email and password.",
      });
      return;
    }

    setState({ status: "signing_in", message: "" });
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password: submittedPassword,
    });

    if (error) {
      setState({
        status: "error",
        message: "The email or password was not accepted.",
      });
      return;
    }

    try {
      const response = await fetch("/api/auth/owner-session", {
        method: "POST",
      });

      if (!response.ok) {
        await supabase.auth.signOut({ scope: "local" });
        setState({
          status: "error",
          message: "This account is not authorized for this private site.",
        });
        return;
      }
    } catch {
      await supabase.auth.signOut({ scope: "local" });
      setState({
        status: "error",
        message: "Owner access could not be verified. Try again.",
      });
      return;
    }

    window.location.replace("/");
  }

  async function requestMagicLink() {
    const normalizedEmail = normalizeAuthEmail(
      emailInputRef.current?.value || email,
    );

    if (!normalizedEmail) {
      setState({
        status: "error",
        message: "Enter the owner email above first.",
      });
      return;
    }

    setState({ status: "sending_link", message: "" });
    const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: buildRecoveryRedirectUrl(window.location.origin),
        shouldCreateUser: false,
      },
    });

    if (error) {
      setState({
        status: "error",
        message: "A sign-in link could not be sent. Confirm the owner email and try again.",
      });
      return;
    }

    setPassword("");
    setState({
      status: "sent",
      message: "Check your inbox. The one-time link opens Settings so you can set a password.",
    });
  }

  const busy =
    state.status === "signing_in" || state.status === "sending_link";

  return (
    <main className="relative grid min-h-screen overflow-hidden lg:grid-cols-[1.05fr_0.95fr]">
      <section className="relative hidden min-h-screen overflow-hidden bg-[var(--ink)] px-12 py-14 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="absolute -right-32 -top-40 size-[34rem] rounded-full border border-white/10" />
        <div className="absolute -right-8 -top-16 size-[22rem] rounded-full border border-[var(--moss-bright)]/25" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--moss-bright)] text-[var(--ink)]">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none">
              <path d="M5 16.5 9.2 8l3.1 5 2.5-7L19 16.5M4 19h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="text-sm font-bold tracking-tight">Signal Foundry</span>
        </div>

        <div className="relative max-w-xl pb-10">
          <p className="mb-5 font-mono text-xs font-bold uppercase tracking-[0.16em] text-[var(--moss-bright)]">Your private opportunity desk</p>
          <h1 className="text-5xl font-semibold leading-[1.04] tracking-[-0.055em] xl:text-6xl">
            Find the business hiding inside the conversation.
          </h1>
          <p className="mt-7 max-w-lg text-base leading-7 text-white/62">
            Daily AI discussions become a handful of specific, evidence-linked offers—without turning hype into false certainty.
          </p>

          <div className="mt-12 grid grid-cols-3 gap-3 border-t border-white/12 pt-6">
            {[
              ["200", "posts scanned"],
              ["3", "model passes"],
              ["0–3", "ideas kept"],
            ].map(([value, label]) => (
              <div key={label}>
                <p className="font-mono text-xl font-semibold text-[var(--moss-bright)]">{value}</p>
                <p className="mt-1 text-xs text-white/46">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex min-h-screen items-center px-5 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-12 flex items-center gap-3 lg:hidden">
            <span className="grid size-10 place-items-center rounded-xl bg-[var(--ink)] text-[var(--moss-bright)]">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none">
                <path d="M5 16.5 9.2 8l3.1 5 2.5-7L19 16.5M4 19h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="text-sm font-bold">Signal Foundry</span>
          </div>

          <p className="eyebrow">Owner access</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Welcome back.</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
            Sign in directly. Your browser or password manager can remember these details for next time.
          </p>

          <form onSubmit={signInWithPassword} className="mt-9">
            <label htmlFor="email" className="text-xs font-bold text-[var(--ink)]">Email address</label>
            <input
              id="email"
              ref={emailInputRef}
              name="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white/80 px-4 py-3.5 text-sm shadow-sm outline-none placeholder:text-[var(--ink-soft)]/45"
            />

            <label htmlFor="password" className="mt-5 block text-xs font-bold text-[var(--ink)]">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white/80 px-4 py-3.5 text-sm shadow-sm outline-none"
            />

            <button
              type="submit"
              disabled={busy}
              className="focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-3.5 text-sm font-bold text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.status === "signing_in" ? "Signing in…" : "Sign in"}
              {state.status !== "signing_in" && <span aria-hidden="true">→</span>}
            </button>
          </form>

          <div className="mt-6 border-t border-[var(--line)] pt-5">
            <button
              type="button"
              aria-expanded={recoveryOpen}
              aria-controls="recovery-options"
              onClick={() => {
                setRecoveryOpen((open) => !open);
                setState(EMPTY_STATE);
              }}
              className="focus-ring rounded-md text-sm font-semibold text-[var(--moss)] underline decoration-[var(--moss)]/35 underline-offset-4"
            >
              {recoveryOpen ? "Hide email-link option" : "No password yet or forgot it?"}
            </button>

            {recoveryOpen && (
              <div id="recovery-options" className="mt-4 rounded-xl border border-[var(--line)] bg-white/55 p-4">
                <p className="text-xs leading-5 text-[var(--ink-soft)]">
                  Use the email entered above. The one-time link signs you in and opens the password section in Settings.
                </p>
                <button
                  type="button"
                  onClick={requestMagicLink}
                  disabled={busy}
                  className="focus-ring mt-3 w-full rounded-lg border border-[var(--ink)]/20 bg-white px-4 py-3 text-sm font-bold text-[var(--ink)] shadow-sm transition-colors hover:border-[var(--moss)]/45 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {state.status === "sending_link" ? "Sending link…" : "Email a one-time sign-in link"}
                </button>
              </div>
            )}
          </div>

          {state.message && (
            <p
              role={state.status === "error" ? "alert" : "status"}
              className={`mt-4 rounded-xl border px-4 py-3 text-sm leading-5 ${
                state.status === "error"
                  ? "border-[var(--rose)]/35 bg-[var(--rose)]/8 text-[#7d3d36]"
                  : "border-[var(--moss)]/25 bg-[var(--moss)]/7 text-[var(--moss)]"
              }`}
            >
              {state.message}
            </p>
          )}

          <p className="mt-8 border-t border-[var(--line)] pt-5 text-xs leading-5 text-[var(--ink-soft)]">
            Access is restricted to one Supabase user ID. Any other authenticated account is signed out automatically.
          </p>
        </div>
      </section>
    </main>
  );
}
