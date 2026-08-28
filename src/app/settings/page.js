import SettingsForm from "@/components/settings-form";
import { requireOwner } from "@/lib/auth";
import { DEFAULT_PREFERENCES, DEFAULT_X_QUERY, PIPELINE } from "@/lib/config";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { ownerId, supabase } = await requireOwner();
  const { data: settings, error } = await supabase
    .from("settings")
    .select("x_query, candidate_limit, ai_input_limit, preferences")
    .eq("owner_id", ownerId)
    .maybeSingle();

  const initialSettings = settings || {
    x_query: DEFAULT_X_QUERY,
    candidate_limit: PIPELINE.maxCandidates,
    ai_input_limit: PIPELINE.defaultAiInputLimit,
    preferences: DEFAULT_PREFERENCES,
  };

  return (
    <main className="shell max-w-4xl py-9 sm:py-12">
      <div>
        <p className="eyebrow">Research settings</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">Tune the signal, not the machinery.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">
          These inputs shape discovery and commercial fit. Each run stores a snapshot so earlier reports remain reproducible.
        </p>
      </div>
      <div className="mt-8">
        {error ? (
          <section className="panel border-[var(--rose)]/30 p-6 text-sm leading-6 text-[#7d433c]">
            Settings could not be loaded, so editing is disabled to protect the saved configuration. Check the database connection and refresh.
          </section>
        ) : (
          <SettingsForm ownerId={ownerId} initialSettings={initialSettings} />
        )}
      </div>
    </main>
  );
}
