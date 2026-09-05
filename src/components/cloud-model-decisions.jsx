import { CandidateDecision, ShortlistDecision } from "@/components/model-decisions";
import CloudComparisonTrigger from "@/components/cloud-comparison-trigger";

const JOB_LABELS = {
  pending: "Waiting to start",
  claimed: "Working in ChatGPT",
  submitted: "Awaiting validation",
  completed: "Validated",
  failed: "Failed",
};
const PHASE_LABELS = {
  shortlist: "Selecting posts",
  generating: "Generating candidates",
  researching: "Researching candidates",
  validating: "Checking the research",
  done: "Finished",
};

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function records(value) {
  return Array.isArray(value) ? value.filter((item) => record(item)) : [];
}

function Field({ label, value }) {
  const content = text(value);
  if (!content) return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ink-soft)]">{content}</dd>
    </div>
  );
}

function RequestedModel({ job }) {
  if (!job) return null;
  return (
    <p className="mt-2 break-words text-xs leading-5 text-[var(--ink-soft)]">
      Requested: {text(job.requested_model) || "Not recorded"}
      {text(job.requested_reasoning) ? ` · ${text(job.requested_reasoning)} reasoning` : ""}.
      {" "}Actual runtime model: unverified.
    </p>
  );
}

function Badge({ children, success = false }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-[0.68rem] font-bold ${success ? "bg-[var(--moss)]/10 text-[var(--moss)]" : "bg-[var(--amber)]/15 text-[#77521d]"}`}>
      {children}
    </span>
  );
}

export default function CloudModelDecisions({ job, assessment, automatic = false, cloudRun, loadError = false }) {
  const candidateJob = record(job);
  const shortlist = record(assessment);
  if (!candidateJob && !shortlist) return null;
  const advanced = shortlist?.advanced === true || shortlist?.decision === "advance";
  const canShowResult = candidateJob && ["submitted", "completed"].includes(candidateJob.status);
  const outcome = candidateJob
    ? JOB_LABELS[candidateJob.status] || "Status unavailable"
    : advanced
      ? ["pending", "running"].includes(cloudRun?.status) ? "Waiting for generation" : "No saved response"
      : "Not selected";
  return (
    <details className="mt-4 min-w-0 rounded-xl border border-[var(--amber)]/35 bg-[var(--amber)]/[0.045]">
      <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 text-sm font-bold">
        <span>ChatGPT cloud decisions</span>
        <span className="ml-2 inline-block align-middle"><Badge success={candidateJob?.status === "completed"}>{outcome}</Badge></span>
      </summary>
      <div className="min-w-0 space-y-5 border-t border-[var(--line)] p-4">
        {candidateJob && (
          <section className="min-w-0">
            <h3 className="eyebrow">ChatGPT cloud · Independent generation</h3>
            <RequestedModel job={candidateJob} />
            {candidateJob.status === "submitted" && (
              <p className="mt-3 rounded-lg bg-[var(--amber)]/15 p-3 text-xs font-semibold leading-5 text-[#77521d]">
                Submitted response — not yet validated. The decision below may change after checks.
              </p>
            )}
            {canShowResult ? (
              <CandidateDecision result={candidateJob.result} critiqueLabel="Cloud critique" />
            ) : (
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ink-soft)]">
                {candidateJob.status === "failed"
                  ? text(candidateJob.error_message) || "The cloud attempt stopped before a valid response was saved."
                  : candidateJob.status === "claimed"
                    ? "ChatGPT is working on this post. Its response has not been submitted yet."
                    : "This post is waiting for its independent cloud generation."}
              </p>
            )}
          </section>
        )}
        {shortlist && (
          <section className={candidateJob ? "min-w-0 border-t border-[var(--line)] pt-4" : "min-w-0"}>
            <h3 className="eyebrow">{automatic ? "Cloud shortlist · Automatic advancement" : "ChatGPT cloud · Shortlist"}</h3>
            <ShortlistDecision assessment={shortlist} automatic={automatic} />
          </section>
        )}
        {loadError && <p className="text-xs leading-5 text-[var(--ink-soft)]">Some cloud responses could not be loaded. Refresh to try again.</p>}
      </div>
    </details>
  );
}

function ResearchSummary({ result, validated = false }) {
  const report = record(result);
  if (!report) return <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">No readable research summary was saved.</p>;
  const assessment = record(report.assessment);
  const ideas = records(report.ideas);
  const sources = records(report.sources);
  return (
    <div className="mt-4 min-w-0 space-y-4">
      <dl className="space-y-3">
        <Field label="Overall evidence" value={text(assessment?.overall_evidence)} />
        <Field label="Research summary" value={assessment?.notes} />
      </dl>
      <p className="text-sm font-semibold">
        {ideas.length} {ideas.length === 1 ? "idea" : "ideas"} {validated ? "passed comparison checks" : "submitted for checking"}
      </p>
      {ideas.map((idea, index) => (
        <details key={index} className="min-w-0 rounded-xl border border-[var(--line)] bg-white/60">
          <summary className="focus-ring cursor-pointer break-words rounded-xl px-4 py-3 text-sm font-semibold">
            {text(idea.title) || `Idea ${index + 1}`}
          </summary>
          <dl className="min-w-0 space-y-4 border-t border-[var(--line)] p-4">
            {[
              ["target_customer", "Customer"], ["problem", "Problem"], ["offer", "Product"],
              ["why_pay", "Why the customer would pay"], ["why_now", "Why now"],
              ["initial_price", "Pricing hypothesis"], ["differentiation", "Differentiation"],
              ["speed_to_first_revenue", "Path to first revenue"], ["validation_plan", "Validation plan"],
            ].map(([key, label]) => <Field key={key} label={label} value={idea[key]} />)}
            <Field label="Minimum viable product" value={record(idea.product_spec)?.mvp_scope} />
            <Field label="Risks" value={Array.isArray(idea.risks) ? idea.risks.filter((item) => typeof item === "string").join("\n") : ""} />
            <Field label="Assumptions" value={Array.isArray(idea.assumptions) ? idea.assumptions.filter((item) => typeof item === "string").join("\n") : ""} />
          </dl>
        </details>
      ))}
      {sources.length > 0 && (
        <details className="min-w-0 rounded-xl border border-[var(--line)]">
          <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold">Sources reported by cloud ({sources.length})</summary>
          <div className="border-t border-[var(--line)] p-4">
            <p className="text-xs leading-5 text-[var(--ink-soft)]">Source access is reported by the cloud worker.</p>
            <ul className="mt-3 space-y-3">
              {sources.map((source, index) => {
                let safeUrl = null;
                try {
                  const url = new URL(text(source.url));
                  if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) safeUrl = url.href;
                } catch {}
                return (
                  <li key={index} className="min-w-0 break-words text-sm leading-6">
                    {safeUrl ? (
                      <a href={safeUrl} target="_blank" rel="noopener noreferrer nofollow" className="focus-ring rounded text-[var(--moss)] underline underline-offset-2">{text(source.title) || safeUrl}</a>
                    ) : <span>{text(source.title) || "Untitled source"}</span>}
                    {text(source.publisher) && <span className="ml-2 text-xs text-[var(--ink-soft)]">{text(source.publisher)}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

export function CloudComparison({ run, jobs = [], loadError = false, sourceRunId, canStart = false }) {
  const cloudRun = record(run);
  if (!cloudRun) {
    return (
      <section className="panel mt-5 p-5">
        <h2 className="eyebrow">ChatGPT cloud comparison</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          {loadError ? "Cloud comparison details are unavailable right now. Refresh to try again." : "No cloud comparison was recorded for this run."}
        </p>
        {!loadError && canStart && <CloudComparisonTrigger runId={sourceRunId} />}
      </section>
    );
  }
  const savedJobs = records(jobs);
  const shortlistJob = savedJobs.find((job) => job.kind === "shortlist");
  const researchJob = savedJobs.find((job) => job.kind === "research");
  const candidates = savedJobs.filter((job) => job.kind === "candidate");
  const final = ["completed", "no_ideas"].includes(cloudRun.status);
  const finalResult = final && record(cloudRun.result)?.mode === "shadow" && cloudRun.result.published === false
    ? cloudRun.result : null;
  const runLabel = cloudRun.status === "completed" ? "Comparison complete"
    : cloudRun.status === "no_ideas" ? "No ideas passed validation"
      : cloudRun.status === "failed" ? "Comparison stopped"
        : cloudRun.status === "pending" ? "Waiting to start"
          : PHASE_LABELS[cloudRun.phase] || "In progress";
  const shortlistComplete = Boolean(record(cloudRun.shortlist_result));
  return (
    <section className="panel mt-5 min-w-0 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="eyebrow">ChatGPT cloud comparison</h2>
        <Badge success={final}>{runLabel}</Badge>
      </div>
      <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">Cloud results are saved for comparison. Published ideas continue to come from the API research.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="min-w-0 rounded-xl bg-[var(--ink)]/[0.035] p-3">
          <h3 className="text-xs font-bold">Shortlist</h3>
          <p className="mt-1 text-sm">{shortlistComplete ? "Validated" : JOB_LABELS[shortlistJob?.status] || "Waiting to start"}</p>
          <RequestedModel job={shortlistJob} />
        </div>
        <div className="min-w-0 rounded-xl bg-[var(--ink)]/[0.035] p-3">
          <h3 className="text-xs font-bold">Independent generation</h3>
          <p className="mt-1 text-sm">{candidates.length
            ? `${candidates.filter((job) => job.status === "completed").length} of ${candidates.length} responses validated`
            : shortlistComplete
              ? cloudRun.shortlist_result.advanced_post_ids?.length ? "Waiting for generation" : "No posts advanced"
              : "Waiting for shortlist"}</p>
          {candidates.length > 0 && <p className="mt-1 text-xs leading-5 text-[var(--ink-soft)]">
            {Object.entries(JOB_LABELS).map(([status, label]) => ({ label, count: candidates.filter((job) => job.status === status).length })).filter((item) => item.count).map((item) => `${item.count} ${item.label.toLowerCase()}`).join(" · ")}
          </p>}
        </div>
        <div className="min-w-0 rounded-xl bg-[var(--ink)]/[0.035] p-3">
          <h3 className="text-xs font-bold">Research</h3>
          <p className="mt-1 text-sm">{JOB_LABELS[researchJob?.status] || (final ? "Not needed" : "Waiting for candidates")}</p>
          <RequestedModel job={researchJob} />
        </div>
      </div>
      {cloudRun.status === "failed" && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-[#88483f]">{text(cloudRun.error_message) || "The comparison stopped before it could finish."}</p>}
      {loadError && <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">Some cloud responses could not be loaded. Refresh to try again.</p>}
      {finalResult ? (
        <details className="mt-4 min-w-0 rounded-xl border border-[var(--line)]">
          <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold">Cloud research summary and comparison ideas</summary>
          <div className="border-t border-[var(--line)] p-4"><ResearchSummary result={finalResult} validated /></div>
        </details>
      ) : researchJob?.status === "submitted" ? (
        <details className="mt-4 min-w-0 rounded-xl border border-[var(--amber)]/35">
          <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold">Submitted research — not yet validated</summary>
          <div className="border-t border-[var(--line)] p-4"><ResearchSummary result={researchJob.result} /></div>
        </details>
      ) : null}
      {shortlistJob?.status === "submitted" && <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">The cloud shortlist was submitted and is waiting for validation. Post decisions will appear after these checks.</p>}
      <a href={`/posts?run=${encodeURIComponent(sourceRunId || cloudRun.id)}`} className="focus-ring mt-4 inline-block rounded text-xs font-bold text-[var(--moss)] hover:underline">Refresh comparison</a>
    </section>
  );
}
