import AccessSettings from "@/components/access-settings";
import SettingsForm from "@/components/settings-form";
import { requireOwner } from "@/lib/auth";
import { DEFAULT_PREFERENCES, DEFAULT_X_QUERY, PIPELINE } from "@/lib/config";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const LEGACY_BUSINESS_MODELS = new Set([
  "productized service",
  "consulting",
  "small saas",
]);

function mergeLists(...lists) {
  const merged = [];
  const seen = new Set();

  for (const list of lists) {
    for (const value of Array.isArray(list) ? list : []) {
      if (typeof value !== "string" || !value.trim()) continue;
      const normalized = value.trim();
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(normalized);
    }
  }

  return merged;
}

function effectivePreferences(saved = {}) {
  const savedBusinessModels = (Array.isArray(saved.preferred_business_models)
    ? saved.preferred_business_models
    : []).filter((model) => !LEGACY_BUSINESS_MODELS.has(String(model).trim().toLowerCase()));

  return {
    ...saved,
    offer_bias: saved.offer_bias || DEFAULT_PREFERENCES.offer_bias,
    preferred_customers: mergeLists(saved.preferred_customers, DEFAULT_PREFERENCES.preferred_customers),
    preferred_business_models: mergeLists(savedBusinessModels, DEFAULT_PREFERENCES.preferred_business_models),
    personal_advantages: mergeLists(saved.personal_advantages, DEFAULT_PREFERENCES.personal_advantages),
    avoid: mergeLists(DEFAULT_PREFERENCES.avoid, saved.avoid),
  };
}

export default async function SettingsPage() {
  const { ownerId, ownerEmail, supabase } = await requireOwner();
  const { data: settings, error } = await supabase
    .from("settings")
    .select("x_query, followed_x_usernames, candidate_limit, ai_input_limit, preferences")
    .eq("owner_id", ownerId)
    .maybeSingle();

  const initialSettings = settings
    ? {
        ...settings,
        followed_x_usernames: settings.followed_x_usernames || [],
        preferences: effectivePreferences(settings.preferences),
      }
    : {
        x_query: DEFAULT_X_QUERY,
        followed_x_usernames: [],
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
      <div className="mt-8 space-y-5">
        {error ? (
          <section className="panel border-[var(--rose)]/30 p-6 text-sm leading-6 text-[#7d433c]">
            Settings could not be loaded, so editing is disabled to protect the saved configuration. Check the database connection and refresh.
          </section>
        ) : (
          <SettingsForm ownerId={ownerId} initialSettings={initialSettings} />
        )}
        <AccessSettings ownerEmail={ownerEmail} />
      </div>
    </main>
  );
}
