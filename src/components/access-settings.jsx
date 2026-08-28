"use client";

import { useState } from "react";
import {
  MIN_OWNER_PASSWORD_LENGTH,
  validatePasswordChange,
} from "@/lib/auth-helpers";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function AccessSettings({ ownerEmail }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState({ status: "idle", message: "" });

  async function updatePassword(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedPassword = formData.get("new-password");
    const submittedConfirmation = formData.get("confirm-password");
    const validationError = validatePasswordChange(
      submittedPassword,
      submittedConfirmation,
    );

    if (validationError) {
      setState({ status: "error", message: validationError });
      return;
    }

    setState({ status: "saving", message: "" });
    const { error } = await createSupabaseBrowserClient().auth.updateUser({
      password: submittedPassword,
    });

    if (error) {
      setState({
        status: "error",
        message: "The password could not be updated. Open a fresh email sign-in link and try again.",
      });
      return;
    }

    setPassword("");
    setConfirmation("");
    setState({
      status: "saved",
      message: "Password updated. You can use direct sign-in next time.",
    });
  }

  return (
    <section id="access" className="panel scroll-mt-24 p-5 sm:p-7">
      <p className="eyebrow">Owner access</p>
      <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">Fast sign-in</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">
        Set or replace the password for the owner account. A valid signed-in session is required, so a one-time email link remains the recovery path.
      </p>

      <form onSubmit={updatePassword} className="mt-6 grid gap-4">
        <label htmlFor="access-email" className="text-xs font-bold">
          Account email
          <input
            id="access-email"
            name="username"
            type="email"
            autoComplete="username"
            readOnly
            value={ownerEmail || ""}
            className="mt-2 w-full rounded-xl border border-[var(--line)] bg-[var(--paper)] px-3.5 py-3 text-sm font-normal text-[var(--ink-soft)] outline-none"
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label htmlFor="new-password" className="text-xs font-bold">
            New password
            <span className="ml-2 font-normal text-[var(--ink-soft)]">
              {MIN_OWNER_PASSWORD_LENGTH}+ characters
            </span>
            <input
              id="new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_OWNER_PASSWORD_LENGTH}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
            />
          </label>

          <label htmlFor="confirm-password" className="text-xs font-bold">
            Confirm password
            <input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_OWNER_PASSWORD_LENGTH}
              required
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
            />
          </label>
        </div>

        <div className="flex flex-col items-start justify-between gap-3 border-t border-[var(--line)] pt-4 sm:flex-row sm:items-center">
          <p
            role={state.status === "error" ? "alert" : "status"}
            className={`text-xs font-semibold ${
              state.status === "error" ? "text-[#88483f]" : "text-[var(--moss)]"
            }`}
          >
            {state.message}
          </p>
          <button
            type="submit"
            disabled={state.status === "saving"}
            className="focus-ring rounded-xl bg-[var(--ink)] px-5 py-3 text-sm font-bold text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state.status === "saving" ? "Updating…" : "Set new password"}
          </button>
        </div>
      </form>
    </section>
  );
}
