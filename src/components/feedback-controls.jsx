"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const decisions = [
  { status: "saved", label: "Save", tone: "positive" },
  { status: "testing", label: "Start testing", tone: "positive" },
  { status: "validated", label: "Validated", tone: "positive" },
  { status: "rejected", label: "Reject", tone: "negative" },
  { status: "archived", label: "Archive", tone: "neutral" },
];

const reasons = [
  ["", "No reason selected"],
  ["strong_fit", "Strong personal fit"],
  ["interesting_customer", "Interesting customer"],
  ["credible_problem", "Credible problem"],
  ["weak_evidence", "Evidence is too weak"],
  ["market_too_crowded", "Market looks too crowded"],
  ["poor_personal_fit", "Poor personal fit"],
  ["too_slow_to_revenue", "Too slow to first revenue"],
  ["too_difficult", "Too difficult to deliver"],
  ["pricing_unrealistic", "Pricing seems unrealistic"],
  ["already_considered", "Already considered"],
  ["other", "Other"],
];

export default function FeedbackControls({ idea }) {
  const router = useRouter();
  const [reason, setReason] = useState(idea.feedback_reason || "");
  const [note, setNote] = useState(idea.feedback_note || "");
  const [status, setStatus] = useState(idea.status);
  const [saving, setSaving] = useState("");
  const [message, setMessage] = useState("");

  async function submit(nextStatus) {
    if (nextStatus === "rejected" && !reason) {
      setMessage("Choose a reason before rejecting this idea.");
      return;
    }

    setSaving(nextStatus);
    setMessage("");

    try {
      const response = await fetch(`/api/ideas/${idea.id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: nextStatus,
          feedback_reason: reason || null,
          feedback_note: note.trim() || null,
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setMessage(payload.error || "Feedback could not be saved.");
        return;
      }

      setStatus(nextStatus);
      setMessage("Decision saved. Future runs will receive this signal.");
      router.refresh();
    } catch {
      setMessage("Feedback could not be saved. Try again.");
    } finally {
      setSaving("");
    }
  }

  return (
    <section className="panel p-5 sm:p-6">
      <p className="eyebrow">Your decision</p>
      <div className="mt-2 flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-[-0.03em]">Shape tomorrow’s results</h2>
        <span className="rounded-full bg-[var(--ink)] px-3 py-1 font-mono text-[0.65rem] font-bold uppercase tracking-wide text-white">{status}</span>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
        The status and reason are retrieved as context when similar opportunities appear again.
      </p>

      <div className="mt-5 grid gap-4">
        <label className="text-xs font-bold">
          Decision reason
          <select
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
          >
            {reasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>

        <label className="text-xs font-bold">
          Private note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 1_000))}
            rows={3}
            placeholder="What makes this promising—or not?"
            className="focus-ring mt-2 w-full resize-y rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal leading-6 outline-none placeholder:text-[var(--ink-soft)]/45"
          />
        </label>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {decisions.map((decision) => (
          <button
            key={decision.status}
            type="button"
            onClick={() => submit(decision.status)}
            disabled={Boolean(saving)}
            className={`focus-ring rounded-xl border px-3.5 py-2.5 text-xs font-bold transition-colors disabled:opacity-45 ${
              decision.tone === "positive"
                ? "border-[var(--moss)]/25 bg-[var(--moss)]/7 text-[var(--moss)] hover:bg-[var(--moss)]/12"
                : decision.tone === "negative"
                  ? "border-[var(--rose)]/25 bg-[var(--rose)]/7 text-[#88483f] hover:bg-[var(--rose)]/12"
                  : "border-[var(--line)] bg-white/60 text-[var(--ink-soft)] hover:bg-white"
            }`}
          >
            {saving === decision.status ? "Saving…" : decision.label}
          </button>
        ))}
      </div>

      {message && <p role="status" className="mt-4 text-xs font-semibold text-[var(--ink-soft)]">{message}</p>}
    </section>
  );
}
