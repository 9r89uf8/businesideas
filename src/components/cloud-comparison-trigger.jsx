"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CloudComparisonTrigger({ runId }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function startComparison() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cloud-comparison`, { method: "POST" });
      if (!response.ok) {
        setMessage(response.status === 409
          ? "This run has no eligible posts available for cloud comparison."
          : "The cloud comparison could not be started. Please try again.");
        return;
      }
      setMessage("Cloud comparison started.");
      router.refresh();
    } catch {
      setMessage("The cloud comparison could not be started. Check the connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3">
      <button type="button" onClick={startComparison} disabled={pending} className="focus-ring rounded-xl bg-[var(--moss)] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-wait disabled:opacity-60">
        {pending ? "Starting comparison…" : "Run cloud comparison"}
      </button>
      <p role="status" className="mt-2 text-xs leading-5 text-[var(--ink-soft)]">{message}</p>
    </div>
  );
}
