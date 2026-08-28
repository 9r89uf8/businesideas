"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { describeRun } from "@/components/run-status-state";

const activeStatuses = new Set(["queued", "running"]);

export default function RunStatus({ initialRun }) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState("");
  const copy = useMemo(() => describeRun(run), [run]);
  const active = Boolean(run && activeStatuses.has(run.status));
  const failed = run?.status === "failed";

  useEffect(() => {
    if (!active || !run?.id) return undefined;

    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const nextRun = await response.json();
        if (cancelled) return;
        setRun(nextRun);

        if (!activeStatuses.has(nextRun.status)) {
          router.refresh();
        }
      } catch {
        // A transient polling failure should not interrupt the workflow.
      }
    }

    const timer = window.setInterval(poll, 5_000);
    poll();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, router, run?.id]);

  async function runNow() {
    setStarting(true);
    setMessage("");

    try {
      const response = await fetch("/api/runs", { method: "POST" });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setMessage(
          response.status === 409
            ? "A research run is already active."
            : payload.error || "The run could not be started.",
        );
        return;
      }

      setRun({
        id: payload.id,
        status: payload.status || "queued",
        stage: payload.stage || null,
        counts: {},
        error_message: null,
      });
      router.refresh();
    } catch {
      setMessage("The run could not be started. Check the connection and try again.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="panel overflow-hidden" aria-live="polite">
      <div className="flex flex-col justify-between gap-6 p-6 sm:flex-row sm:items-center sm:p-7">
        <div className="flex items-start gap-4">
          <span
            className={`mt-1 size-3 shrink-0 rounded-full ${
              active
                ? "status-pulse bg-[var(--moss-bright)]"
                : run?.status === "failed"
                  ? "bg-[var(--rose)]"
                  : "bg-[var(--moss)]"
            }`}
          />
          <div>
            <p className="eyebrow">Daily research</p>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-2xl font-semibold tracking-[-0.035em]">{copy.label}</h2>
              {run?.stage && (active || failed) && (
                <span className={`rounded-full px-2.5 py-1 font-mono text-[0.65rem] font-semibold uppercase tracking-wide ${
                  failed
                    ? "bg-[var(--rose)]/10 text-[#88483f]"
                    : "bg-[var(--moss)]/8 text-[var(--moss)]"
                }`}>
                  {run.stage}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm leading-6 text-[var(--ink-soft)]">{copy.detail}</p>
            {failed && (
              <dl className="mt-3 grid gap-1.5 text-xs leading-5">
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-bold text-[var(--ink)]">Last stage:</dt>
                  <dd className="text-[var(--ink-soft)]">{copy.lastStage}</dd>
                </div>
                <div className="flex flex-wrap gap-x-2">
                  <dt className="font-bold text-[var(--ink)]">Safe error:</dt>
                  <dd className="text-[#7d433c]">{copy.safeError}</dd>
                </div>
              </dl>
            )}
            {message && <p className="mt-2 text-xs font-semibold text-[#8c493f]">{message}</p>}
          </div>
        </div>

        <button
          type="button"
          onClick={runNow}
          disabled={active || starting}
          className="focus-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--ink)] px-5 text-sm font-bold text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4" fill="none">
            <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {starting ? "Starting…" : active ? "Run in progress" : "Run now"}
        </button>
      </div>
      {active && (
        <div className="h-1 overflow-hidden bg-[var(--line)]">
          <div className="h-full w-2/5 animate-pulse rounded-r-full bg-[var(--moss-bright)]" />
        </div>
      )}
    </section>
  );
}
