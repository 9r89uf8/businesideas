import Link from "next/link";
import EmptyReport from "@/components/empty-report";
import IdeaCard from "@/components/idea-card";
import RunStatus from "@/components/run-status";
import { describeRun } from "@/components/run-status-state";
import { requireOwner } from "@/lib/auth";

export const dynamic = "force-dynamic";

function formatDate(value, includeTime = false) {
  if (!value) return "Not yet";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(value));
}

function runLabel(run) {
  if (run.status === "no_ideas") return "No ideas";
  return run.status.charAt(0).toUpperCase() + run.status.slice(1);
}

function countValue(counts, keys) {
  for (const key of keys) {
    if (Number.isFinite(counts?.[key])) return counts[key];
  }
  return 0;
}

function RunTableStatus({ run }) {
  const description = describeRun(run);

  return (
    <div>
      <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${
        run.status === "failed"
          ? "bg-[var(--rose)]/10 text-[#88483f]"
          : "bg-[var(--moss)]/8 text-[var(--moss)]"
      }`}>
        {runLabel(run)}
      </span>
      {run.status === "failed" && (
        <dl className="mt-2 max-w-sm text-xs leading-5 text-[var(--ink-soft)]">
          <div>
            <dt className="inline font-bold text-[var(--ink)]">Last stage: </dt>
            <dd className="inline">{description.lastStage}</dd>
          </div>
          <div>
            <dt className="inline font-bold text-[var(--ink)]">Safe error: </dt>
            <dd className="inline text-[#7d433c]">{description.safeError}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

export default async function DashboardPage() {
  const { ownerId, supabase } = await requireOwner();

  const [runsResult, successfulResult] = await Promise.all([
    supabase
      .from("runs")
      .select("id, status, stage, counts, error_message, trigger, created_at, started_at, completed_at")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("runs")
      .select("id, status, completed_at")
      .eq("owner_id", ownerId)
      .in("status", ["completed", "no_ideas"])
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const { data: recentRuns, error: runsError } = runsResult;
  const { data: lastSuccessfulRun, error: successfulError } = successfulResult;

  if (runsError || successfulError) {
    return (
      <main className="shell py-12">
        <section className="panel border-[var(--rose)]/30 p-6 text-sm leading-6 text-[#7d433c]">
          The research dashboard could not load its run history. Confirm the initial Supabase migration and database connection, then refresh.
        </section>
      </main>
    );
  }

  const runs = recentRuns || [];
  const latestRun = runs[0] || null;
  let ideas = [];
  let reportError = null;

  if (lastSuccessfulRun?.id) {
    const { data: runIdeas, error: ideasError } = await supabase
      .from("ideas")
      .select("id, rank, title, target_customer, problem, offer, product_spec, evidence_score, status")
      .eq("owner_id", ownerId)
      .eq("run_id", lastSuccessfulRun.id)
      .order("rank", { ascending: true });

    reportError = ideasError;
    ideas = runIdeas || [];

    if (ideas.length && !reportError) {
      const ideaIds = ideas.map((idea) => idea.id);
      const { data: sources, error: sourcesError } = await supabase
        .from("idea_sources")
        .select("idea_id")
        .eq("owner_id", ownerId)
        .in("idea_id", ideaIds);
      reportError = sourcesError;
      const countsByIdea = (sources || []).reduce((counts, source) => {
        counts[source.idea_id] = (counts[source.idea_id] || 0) + 1;
        return counts;
      }, {});

      if (!reportError) {
        ideas = ideas.map((idea) => ({
          ...idea,
          sourceCount: countsByIdea[idea.id] || 0,
        }));
      }
    }
  }

  const counts = latestRun?.counts || {};
  const latestRunDescription = describeRun(latestRun);
  const metrics = [
    { label: "Candidates", value: countValue(counts, ["after_filtering", "x_returned"]) },
    { label: "Signals", value: countValue(counts, ["relevant_signals"]) },
    { label: "Clusters", value: countValue(counts, ["clusters_created", "eligible_clusters"]) },
    { label: "Ideas", value: countValue(counts, ["ideas_saved"]) },
  ];

  return (
    <main className="shell py-9 sm:py-12">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow">Today’s opportunity brief</p>
          <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">
            Commercial signals, distilled into self-serve web products.
          </h1>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <p className="text-xs text-[var(--ink-soft)]">Last successful research window</p>
          <p className="mt-1 font-mono text-sm font-bold">
            {formatDate(lastSuccessfulRun?.completed_at, true)}
          </p>
        </div>
      </div>

      <div className="mt-8">
        <RunStatus initialRun={latestRun} />
      </div>

      {latestRun && (
        <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="panel px-4 py-4 sm:px-5">
              <p className="font-mono text-2xl font-semibold tracking-[-0.04em]">{metric.value}</p>
              <p className="mt-1 text-xs font-semibold text-[var(--ink-soft)]">{metric.label}</p>
            </div>
          ))}
        </section>
      )}

      {latestRun?.status === "failed" && (
        <section className="mt-5 rounded-2xl border border-[var(--rose)]/30 bg-[var(--rose)]/8 px-5 py-4">
          <p className="eyebrow !text-[#88483f]">Last run error</p>
          <dl className="mt-2 grid gap-1 text-sm leading-6 text-[#713e37] sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="font-bold">Last stage</dt>
            <dd>{latestRunDescription.lastStage}</dd>
            <dt className="font-bold">Safe error</dt>
            <dd>{latestRunDescription.safeError}</dd>
          </dl>
        </section>
      )}

      <section className="mt-12">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Evidence-backed ideas</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">Latest report</h2>
          </div>
          <Link href="/ideas" className="focus-ring rounded-md text-sm font-bold text-[var(--moss)] hover:underline">
            Browse archive →
          </Link>
        </div>

        <div className="mt-5">
          {reportError ? (
            <section className="panel border-[var(--rose)]/30 p-6 text-sm leading-6 text-[#7d433c]">
              The latest report exists, but its ideas or evidence links could not be loaded safely. Refresh after the database connection recovers.
            </section>
          ) : ideas.length ? (
            <div className="grid gap-4 lg:grid-cols-3">
              {ideas.map((idea) => <IdeaCard key={idea.id} idea={idea} />)}
            </div>
          ) : (
            <EmptyReport
              hasRun={Boolean(lastSuccessfulRun)}
              failed={latestRun?.status === "failed" && !lastSuccessfulRun}
            />
          )}
        </div>
      </section>

      <section className="mt-12 pb-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Audit trail</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">Recent runs</h2>
          </div>
        </div>

        <div className="panel mt-5 overflow-x-auto">
          {runs.length ? (
            <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
              <thead className="border-b border-[var(--line)] text-[0.68rem] uppercase tracking-wider text-[var(--ink-soft)]">
                <tr>
                  <th className="px-5 py-3 font-bold">Started</th>
                  <th className="px-5 py-3 font-bold">Trigger</th>
                  <th className="px-5 py-3 font-bold">Status</th>
                  <th className="px-5 py-3 text-right font-bold">Candidates</th>
                  <th className="px-5 py-3 text-right font-bold">Signals</th>
                  <th className="px-5 py-3 text-right font-bold">Ideas</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-[var(--line)]/70 last:border-0">
                    <td className="px-5 py-3.5 font-medium">{formatDate(run.started_at || run.created_at, true)}</td>
                    <td className="px-5 py-3.5 capitalize text-[var(--ink-soft)]">{run.trigger}</td>
                    <td className="px-5 py-3.5">
                      <RunTableStatus run={run} />
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono">{countValue(run.counts, ["after_filtering", "x_returned"])}</td>
                    <td className="px-5 py-3.5 text-right font-mono">{countValue(run.counts, ["relevant_signals"])}</td>
                    <td className="px-5 py-3.5 text-right font-mono">{countValue(run.counts, ["ideas_saved"])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-5 py-8 text-center text-sm text-[var(--ink-soft)]">No runs have been recorded.</p>
          )}
        </div>
      </section>
    </main>
  );
}
