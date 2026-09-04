const AUTOMATIC_SHORTLIST_REASON =
  "The survivor set is small enough for independent generation.";
const GENERATION_PENDING_STAGES = new Set([
  "fetching",
  "extracting",
  "shortlisting",
  "clustering",
  "generating",
]);
const SELECTED_IDEA_FIELDS = [
  ["payer", "Payer"],
  ["user", "User"],
  ["problem_or_opportunity", "Problem or opportunity"],
  ["product", "Product"],
  ["how_the_post_enables_it", "How this post enables it"],
  ["why_source_product_is_not_enough", "Why the source product is not enough"],
  ["current_alternative", "Current alternative"],
  ["payment_reason", "Why the customer would pay"],
  ["pricing_hypothesis", "Pricing hypothesis"],
  ["distribution", "Distribution"],
  ["mvp", "Minimum viable product"],
  ["largest_risk", "Largest risk"],
];

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function humanize(value) {
  return text(value).replaceAll("_", " ");
}

function scoreLabel(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100
    ? `${value}/100`
    : "";
}

function Field({ label, value }) {
  const content = text(value);
  if (!content) return null;
  return (
    <div className="min-w-0">
      <dt className="text-xs font-bold text-[var(--ink)]">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ink-soft)]">
        {content}
      </dd>
    </div>
  );
}

function SelectedIdea({ idea }) {
  if (!idea) {
    return (
      <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
        The selected idea details were not saved.
      </p>
    );
  }
  const score = scoreLabel(idea.score);
  return (
    <details className="mt-4 min-w-0 rounded-xl border border-[var(--moss)]/20 bg-white/70">
      <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 text-sm font-bold text-[var(--moss)]">
        Selected idea details
      </summary>
      <div className="min-w-0 border-t border-[var(--line)] p-4">
        <p className="break-words text-base font-semibold leading-6">
          {text(idea.title) || "Untitled candidate"}
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ink-soft)]">
          {text(idea.business_form) && <span className="min-w-0 break-words capitalize">{humanize(idea.business_form)}</span>}
          {score && <span><span className="font-bold">Commercial quality:</span> {score}</span>}
        </div>
        <dl className="mt-4 space-y-4">
          {SELECTED_IDEA_FIELDS.map(([key, label]) => (
            <Field key={key} label={label} value={idea[key]} />
          ))}
        </dl>
      </div>
    </details>
  );
}

function Concepts({ concepts }) {
  const savedConcepts = Array.isArray(concepts)
    ? concepts.filter((concept) => record(concept))
    : [];
  return (
    <div className="mt-5">
      <h4 className="text-xs font-bold">Concepts considered</h4>
      {savedConcepts.length ? (
        <ol className="mt-3 space-y-3">
          {savedConcepts.map((concept, index) => (
            <li key={index} className="min-w-0 rounded-xl border border-[var(--line)] bg-white/60 p-4">
              <p className="break-words text-sm font-semibold leading-6">
                <span className="mr-2 font-mono text-xs text-[var(--ink-soft)]">{index + 1}.</span>
                {text(concept.title) || "Untitled concept"}
              </p>
              {text(concept.business_form) && (
                <p className="mt-1 break-words text-xs capitalize text-[var(--ink-soft)]">
                  {humanize(concept.business_form)}
                </p>
              )}
              <dl className="mt-3 space-y-3">
                <Field label="Concept" value={concept.summary} />
                <Field label="Payer" value={concept.payer} />
                <Field label="Sol's critique" value={concept.critique} />
              </dl>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          No concept details were saved.
        </p>
      )}
    </div>
  );
}

export default function ModelDecisions({
  snapshot,
  candidateResult = null,
  runStatus,
  runStage,
  shortlistSkipped = false,
  loadError = false,
}) {
  const post = record(snapshot) || {};
  const result = record(candidateResult);
  const shortlist = record(post.shortlist_assessment);
  const context = record(post.hydrated_context);
  const automaticShortlist =
    shortlistSkipped || text(shortlist?.reason) === AUTOMATIC_SHORTLIST_REASON;
  const generationStatus = ["candidate", "no_viable_idea"].includes(result?.status)
    ? result.status
    : null;
  const pending =
    (runStatus === "queued" || runStatus === "running") &&
    (GENERATION_PENDING_STAGES.has(runStage) ||
      (runStatus === "queued" && !runStage));
  const outcome = loadError
    ? "Unavailable"
    : generationStatus === "candidate"
      ? "Candidate selected"
      : generationStatus === "no_viable_idea"
        ? "No viable idea"
        : pending
          ? "Generation pending"
          : "No saved response";
  const badgeClass =
    !loadError && generationStatus === "candidate"
      ? "bg-[var(--moss)]/10 text-[var(--moss)]"
      : !loadError && generationStatus === "no_viable_idea"
        ? "bg-[var(--rose)]/10 text-[#88483f]"
        : "bg-[var(--amber)]/15 text-[#77521d]";

  return (
    <details className="mt-4 min-w-0 rounded-xl border border-[var(--line)] bg-[var(--ink)]/[0.025]">
      <summary className="focus-ring cursor-pointer rounded-xl px-4 py-3 text-sm font-bold">
        <span>Model decisions</span>
        <span className={`ml-2 inline-block rounded-full px-2.5 py-1 align-middle text-[0.68rem] font-bold ${badgeClass}`}>
          {outcome}
        </span>
      </summary>
      <div className="min-w-0 space-y-5 border-t border-[var(--line)] p-4">
        <section className="min-w-0">
          <h3 className="eyebrow">Sol · Independent generation</h3>
          {loadError ? (
            <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
              The saved generation response is unavailable right now. Reload to try again.
            </p>
          ) : generationStatus ? (
            <>
              <p className="mt-2 text-sm font-semibold">{outcome}</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--ink-soft)]">
                {text(result.reason) || "No decision reason was saved."}
              </p>
              {generationStatus === "candidate" && (
                <SelectedIdea idea={record(result.selected_idea)} />
              )}
              <Concepts concepts={result.concepts_considered} />
            </>
          ) : (
            <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
              {pending
                ? "This post is shortlisted. Its generation response has not been saved yet."
                : "No saved generation response is available for this post."}
            </p>
          )}
        </section>

        <section className="min-w-0 border-t border-[var(--line)] pt-4">
          <h3 className="eyebrow">{automaticShortlist ? "Shortlist · Automatic advancement" : "Sol · Shortlist"}</h3>
          {automaticShortlist ? (
            <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
              Automatically advanced: eight or fewer posts survived, so all could proceed to independent generation.
            </p>
          ) : shortlist ? (
            <dl className="mt-3 space-y-3">
              <Field label="Decision" value={humanize(shortlist.decision)} />
              <Field label="Reason" value={shortlist.reason} />
              <Field label="Commercial inspiration score" value={scoreLabel(shortlist.commercial_inspiration_score)} />
              <Field label="What changed" value={shortlist.what_changed} />
              <Field label="Possible payer" value={shortlist.possible_payer} />
              <Field label="Build angle" value={shortlist.one_line_build_angle} />
            </dl>
          ) : (
            <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">No shortlist assessment was saved.</p>
          )}
        </section>

        {context && (
          <section className="min-w-0 border-t border-[var(--line)] pt-4">
            <h3 className="eyebrow">Luna · Linked context</h3>
            <dl className="mt-3 space-y-3">
              <Field label="Outcome" value={humanize(context.status)} />
              <Field label="Context summary" value={context.context_summary} />
              <Field label="Reason" value={context.reason} />
              <Field label="Commercial element" value={humanize(context.commercial_element)} />
            </dl>
          </section>
        )}

        {(text(post.filter_decision) || text(post.filter_reason)) && (
          <section className="min-w-0 border-t border-[var(--line)] pt-4">
            <h3 className="eyebrow">Luna · Post filter</h3>
            <dl className="mt-3 space-y-3">
              <Field label="Decision" value={humanize(post.filter_decision)} />
              <Field label="Reason" value={post.filter_reason} />
              <Field label="Commercial element" value={humanize(post.commercial_element)} />
            </dl>
          </section>
        )}
      </div>
    </details>
  );
}
