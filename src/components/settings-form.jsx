"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

function fromLines(value) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function toLines(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function ListField({ label, hint, value, onChange }) {
  return (
    <label className="text-xs font-bold">
      {label}
      <span className="ml-2 font-normal text-[var(--ink-soft)]">{hint}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        className="focus-ring mt-2 w-full resize-y rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal leading-6 outline-none"
      />
    </label>
  );
}

export default function SettingsForm({ ownerId, initialSettings }) {
  const preferences = initialSettings.preferences || {};
  const [form, setForm] = useState({
    xQuery: initialSettings.x_query,
    candidateLimit: initialSettings.candidate_limit,
    aiInputLimit: initialSettings.ai_input_limit,
    offerBias: preferences.offer_bias || "services_first",
    preferredCustomers: toLines(preferences.preferred_customers),
    preferredBusinessModels: toLines(preferences.preferred_business_models),
    personalAdvantages: toLines(preferences.personal_advantages),
    avoid: toLines(preferences.avoid),
  });
  const [state, setState] = useState({ status: "idle", message: "" });

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save(event) {
    event.preventDefault();
    setState({ status: "saving", message: "" });

    const candidateLimit = Number(form.candidateLimit);
    const aiInputLimit = Number(form.aiInputLimit);

    if (
      !form.xQuery.trim() ||
      candidateLimit < 50 ||
      candidateLimit > 200 ||
      aiInputLimit < 25 ||
      aiInputLimit > 100 ||
      aiInputLimit > candidateLimit
    ) {
      setState({ status: "error", message: "Check the query and input limits before saving." });
      return;
    }

    const { error } = await createSupabaseBrowserClient()
      .from("settings")
      .upsert({
        owner_id: ownerId,
        x_query: form.xQuery.trim(),
        candidate_limit: candidateLimit,
        ai_input_limit: aiInputLimit,
        preferences: {
          offer_bias: form.offerBias,
          preferred_customers: fromLines(form.preferredCustomers),
          preferred_business_models: fromLines(form.preferredBusinessModels),
          personal_advantages: fromLines(form.personalAdvantages),
          avoid: fromLines(form.avoid),
        },
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id" });

    if (error) {
      setState({ status: "error", message: "Settings could not be saved." });
      return;
    }

    setState({ status: "saved", message: "Settings saved. They will be snapshotted on the next run." });
  }

  return (
    <form onSubmit={save} className="space-y-5">
      <section className="panel p-5 sm:p-7">
        <p className="eyebrow">Discovery</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">X research input</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">Use one focused query and tune it from observed results. Retweets remain excluded.</p>

        <label className="mt-6 block text-xs font-bold">
          X recent-search query
          <textarea
            value={form.xQuery}
            onChange={(event) => update("xQuery", event.target.value.slice(0, 512))}
            rows={9}
            required
            className="focus-ring mt-2 w-full resize-y rounded-xl border border-[var(--line)] bg-[#202b26] px-4 py-3 font-mono text-xs leading-6 text-[#eef5ed] outline-none"
          />
        </label>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="text-xs font-bold">
            Candidate limit <span className="font-normal text-[var(--ink-soft)]">50–200</span>
            <input
              type="number"
              min="50"
              max="200"
              value={form.candidateLimit}
              onChange={(event) => update("candidateLimit", event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
            />
          </label>
          <label className="text-xs font-bold">
            AI input limit <span className="font-normal text-[var(--ink-soft)]">25–100</span>
            <input
              type="number"
              min="25"
              max="100"
              value={form.aiInputLimit}
              onChange={(event) => update("aiInputLimit", event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
            />
          </label>
        </div>
      </section>

      <section className="panel p-5 sm:p-7">
        <p className="eyebrow">Commercial fit</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">Generation preferences</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">These guide Sol after evidence clears the cluster gates. They do not override weak evidence.</p>

        <div className="mt-6 grid gap-5">
          <label className="text-xs font-bold">
            Offer preference
            <select
              value={form.offerBias}
              onChange={(event) => update("offerBias", event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
            >
              <option value="services_first">Services first</option>
              <option value="balanced">Balanced</option>
              <option value="software_first">Software first</option>
            </select>
          </label>
          <div className="grid gap-5 md:grid-cols-2">
            <ListField label="Preferred customers" hint="one per line" value={form.preferredCustomers} onChange={(value) => update("preferredCustomers", value)} />
            <ListField label="Preferred business models" hint="one per line" value={form.preferredBusinessModels} onChange={(value) => update("preferredBusinessModels", value)} />
            <ListField label="Personal advantages" hint="one per line" value={form.personalAdvantages} onChange={(value) => update("personalAdvantages", value)} />
            <ListField label="Avoid" hint="one per line" value={form.avoid} onChange={(value) => update("avoid", value)} />
          </div>
        </div>
      </section>

      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <p role="status" className={`text-xs font-semibold ${state.status === "error" ? "text-[#88483f]" : "text-[var(--moss)]"}`}>{state.message}</p>
        <button
          type="submit"
          disabled={state.status === "saving"}
          className="focus-ring rounded-xl bg-[var(--ink)] px-5 py-3 text-sm font-bold text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:opacity-50"
        >
          {state.status === "saving" ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
