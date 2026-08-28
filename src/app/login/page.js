"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState({ status: "idle", message: "" });

  useEffect(() => {
    const error = new URL(window.location.href).searchParams.get("error");
    if (error) {
      setState({
        status: "error",
        message: "That sign-in link could not be verified. Request a fresh link.",
      });
    }
  }, []);

  async function requestMagicLink(event) {
    event.preventDefault();
    setState({ status: "loading", message: "" });

    const { error } = await createSupabaseBrowserClient().auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        shouldCreateUser: false,
      },
    });

    if (error) {
      setState({
        status: "error",
        message: "A link could not be sent. Confirm the owner email and try again.",
      });
      return;
    }

    setState({
      status: "sent",
      message: "Check your inbox. The link expires shortly and can be used once.",
    });
  }

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
            Enter the configured owner email. We’ll send a password-free sign-in link.
          </p>

          <form onSubmit={requestMagicLink} className="mt-9">
            <label htmlFor="email" className="text-xs font-bold text-[var(--ink)]">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white/80 px-4 py-3.5 text-sm shadow-sm outline-none placeholder:text-[var(--ink-soft)]/45"
            />
            <button
              type="submit"
              disabled={state.status === "loading" || !email.trim()}
              className="focus-ring mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--ink)] px-4 py-3.5 text-sm font-bold text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {state.status === "loading" ? "Sending link…" : "Email me a sign-in link"}
              {state.status !== "loading" && <span aria-hidden="true">→</span>}
            </button>
          </form>

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
            Access is restricted to one Supabase user ID. Other accounts are rejected even if they obtain a valid session.
          </p>
        </div>
      </section>
    </main>
  );
}
