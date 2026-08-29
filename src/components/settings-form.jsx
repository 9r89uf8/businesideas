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

const OFFER_BIASES = new Set([
  "self_serve_web_products_first",
  "evidence_led_balanced",
  "latam_opportunities_first",
  "remote_income_first",
  "ai_cost_collapse_first",
  "distribution_tools_first",
]);

function normalizedOfferBias(value) {
  return OFFER_BIASES.has(value) ? value : "self_serve_web_products_first";
}

function parseFollowedUsernames(value) {
  const usernames = [];
  const invalid = [];
  const seen = new Set();

  for (const line of value.split("\n")) {
    const username = line.trim().replace(/^@+/, "").toLowerCase();
    if (!username) continue;
    if (!/^[a-z0-9_]{1,15}$/.test(username)) {
      invalid.push(line.trim());
      continue;
    }
    if (seen.has(username)) continue;
    seen.add(username);
    usernames.push(username);
  }

  return { usernames: usernames.slice(0, 12), invalid, tooMany: usernames.length > 12 };
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
    followedUsernames: toLines(initialSettings.followed_x_usernames),
    candidateLimit: initialSettings.candidate_limit,
    aiInputLimit: initialSettings.ai_input_limit,
    offerBias: normalizedOfferBias(preferences.offer_bias),
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
    const followed = parseFollowedUsernames(form.followedUsernames);

    if (
      !form.xQuery.trim() ||
      candidateLimit < 50 ||
      candidateLimit > 200 ||
      aiInputLimit < 25 ||
      aiInputLimit > 100 ||
      aiInputLimit > candidateLimit ||
      followed.invalid.length > 0 ||
      followed.tooMany
    ) {
      setState({
        status: "error",
        message: followed.invalid.length
          ? "Each X username must be 1–15 letters, numbers, or underscores."
          : followed.tooMany
            ? "Keep the followed-account list to 12 usernames or fewer."
            : "Check the query and input limits before saving.",
      });
      return;
    }

    const { error } = await createSupabaseBrowserClient()
      .from("settings")
      .upsert({
        owner_id: ownerId,
        x_query: form.xQuery.trim(),
        followed_x_usernames: followed.usernames,
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
      <section id="x-sources" className="panel scroll-mt-24 p-5 sm:p-7">
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

        <div className="mt-5 grid gap-4 rounded-2xl border border-[var(--moss)]/15 bg-[var(--moss)]/[0.035] p-4 sm:grid-cols-[minmax(0,1fr)_15rem] sm:items-start">
          <div>
            <label className="text-xs font-bold">
              Followed X accounts <span className="font-normal text-[var(--ink-soft)]">one username per line · up to 12</span>
              <textarea
                value={form.followedUsernames}
                onChange={(event) => update("followedUsernames", event.target.value)}
                rows={6}
                spellCheck="false"
                placeholder={"username_without_at\nanother_builder"}
                className="focus-ring mt-2 w-full resize-y rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 font-mono text-sm font-normal leading-6 outline-none"
              />
            </label>
          </div>
          <div className="rounded-xl bg-white/75 p-4 text-xs leading-5 text-[var(--ink-soft)]">
            <p className="font-bold text-[var(--ink)]">Preferred, never forced</p>
            <p className="mt-2">Every post must first reach 50K views, including posts from preferred accounts. Views, comments, likes, then saves rank the posts that qualify. Reposts and quotes do not affect quality. Preferred posts can fill at most half of the signal-model input; topic discovery fills the rest.</p>
          </div>
        </div>

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
            Opportunity emphasis <span className="font-normal text-[var(--ink-soft)]">soft preference, never a quota</span>
            <select
              value={form.offerBias}
              onChange={(event) => update("offerBias", event.target.value)}
              className="focus-ring mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 text-sm font-normal outline-none"
            >
              <option value="self_serve_web_products_first">Self-serve web products first</option>
              <option value="evidence_led_balanced">Evidence-led mix</option>
              <option value="latam_opportunities_first">LATAM opportunities first</option>
              <option value="remote_income_first">Remote-income tools first</option>
              <option value="ai_cost_collapse_first">AI cost-collapse tools first</option>
              <option value="distribution_tools_first">Distribution tools first</option>
            </select>
          </label>
          <div className="grid gap-5 md:grid-cols-2">
            <ListField label="Preferred customers" hint="one per line" value={form.preferredCustomers} onChange={(value) => update("preferredCustomers", value)} />
            <ListField label="Preferred business models" hint="one per line" value={form.preferredBusinessModels} onChange={(value) => update("preferredBusinessModels", value)} />
            <ListField label="Personal advantages" hint="one per line" value={form.personalAdvantages} onChange={(value) => update("personalAdvantages", value)} />
            <ListField label="Avoid" hint="one per line · hard rules stay enforced" value={form.avoid} onChange={(value) => update("avoid", value)} />
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white/55 p-4 sm:p-5">
          <p className="eyebrow">Always enforced</p>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">Every published idea must be a self-serve website with a one-developer 2–6 week MVP, concrete recurring value, and no required sales call.</p>
          <div className="mt-3 flex flex-wrap gap-2 text-[0.68rem] font-bold text-[var(--ink-soft)]">
            {["No hardware", "No medical or therapy", "No consulting or agency", "No custom implementation", "No long enterprise sales", "No translation product", "No generic chatbot", "No synthetic companion"].map((rule) => (
              <span key={rule} className="rounded-full bg-black/5 px-2.5 py-1.5">{rule}</span>
            ))}
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
