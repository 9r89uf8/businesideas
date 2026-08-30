import EvidenceList from "@/components/evidence-list";
import ExternalResearchList from "@/components/external-research-list";
import FeedbackControls from "@/components/feedback-controls";

function Section({ label, children }) {
  if (!children) return null;
  return (
    <div>
      <p className="eyebrow">{label}</p>
      <div className="mt-2 text-sm leading-6 text-[var(--ink)]">{children}</div>
    </div>
  );
}

function List({ items }) {
  if (!items?.length) return <p className="text-[var(--ink-soft)]">None recorded.</p>;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--amber)]" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function humanize(value) {
  return typeof value === "string"
    ? value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Not specified";
}

function ProductContract({ spec }) {
  if (!spec?.core_action) return null;

  return (
    <section className="panel overflow-hidden">
      <div className="border-b border-[var(--line)] bg-[var(--ink)] px-5 py-5 text-white sm:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--moss-bright)]">Self-serve product contract</p>
            <p className="mt-2 text-base leading-7">{spec.core_action}</p>
          </div>
          <span className="rounded-full border border-white/15 bg-white/8 px-3 py-1.5 text-xs font-bold">
            {spec.mvp_build_weeks}-week MVP
          </span>
        </div>
      </div>
      <div className="grid gap-7 p-5 sm:grid-cols-2 sm:p-7">
        <Section label="Recurring reason to return">{spec.recurring_trigger}</Section>
        <Section label="Business model">{humanize(spec.business_model)}</Section>
        <Section label="Narrow MVP scope">{spec.mvp_scope}</Section>
        <Section label="LATAM fit">
          <span className="font-bold">{humanize(spec.latam_fit)}.</span> {spec.latam_rationale}
        </Section>
        <div className="sm:col-span-2">
          <p className="eyebrow">Concrete customer advantage</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(spec.value_mechanisms || []).map((mechanism) => (
              <span key={mechanism} className="rounded-full bg-[var(--moss)]/8 px-3 py-1.5 text-xs font-bold text-[var(--moss)]">
                {humanize(mechanism)}
              </span>
            ))}
            <span className="rounded-full bg-[var(--amber)]/15 px-3 py-1.5 text-xs font-bold text-[#77521d]">
              {humanize(spec.sales_motion)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function IdeaDetail({
  idea,
  sources,
  researchSources,
  feedback,
  evidenceNotice,
  researchNotice,
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-5">
        <section className="panel p-5 sm:p-7">
          <div className="grid gap-7 sm:grid-cols-2">
            <Section label="Customer">{idea.target_customer}</Section>
            <Section label="Price assumption">{idea.initial_price || "Not specified"}</Section>
            <Section label="Observed problem">{idea.problem}</Section>
            <Section label={idea.product_spec?.core_action ? "Self-serve web product" : "Sellable first offer"}>{idea.offer}</Section>
          </div>
        </section>

        <ProductContract spec={idea.product_spec} />

        <section className="panel p-5 sm:p-7">
          <div className="grid gap-7 sm:grid-cols-2">
            <Section label="Why the buyer would pay">{idea.why_pay}</Section>
            <Section label="Why now">{idea.why_now || "Not specified"}</Section>
            <Section label="Differentiation">{idea.differentiation || "Not specified"}</Section>
            <Section label="Speed to first revenue">{idea.speed_to_first_revenue || "Not specified"}</Section>
          </div>
        </section>

        <section className="panel overflow-hidden">
          <div className="border-b border-[var(--line)] bg-[var(--moss)] px-5 py-5 text-white sm:px-7">
            <p className="font-mono text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--moss-bright)]">Seven-day validation experiment</p>
            <p className="mt-2 text-base leading-7">{idea.validation_plan}</p>
          </div>
          <div className="grid gap-7 p-5 sm:grid-cols-2 sm:p-7">
            <Section label="Risks"><List items={idea.risks} /></Section>
            <Section label="Model assumptions"><List items={idea.assumptions} /></Section>
          </div>
        </section>

        <section className="panel p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">Direct X evidence</p>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">What people actually said</h2>
            </div>
            <p className="max-w-xs text-right text-xs leading-5 text-[var(--ink-soft)]">Posts support the problem signal; they do not independently prove market size or willingness to pay.</p>
          </div>
          {evidenceNotice && (
            <div
              role="status"
              className="mt-5 rounded-xl border border-[var(--amber)]/35 bg-[var(--amber)]/10 px-4 py-3 text-xs leading-5 text-[#70552d]"
            >
              {evidenceNotice}
            </div>
          )}
          <div className="mt-5"><EvidenceList sources={sources} /></div>
        </section>

        <section className="panel p-5 sm:p-7">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">External market research</p>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.03em]">
                What the scheduled research verified
              </h2>
            </div>
            <p className="max-w-xs text-right text-xs leading-5 text-[var(--ink-soft)]">
              These links support market, pricing, feasibility, competition, or
              distribution claims. Model inferences remain listed separately as
              assumptions.
            </p>
          </div>
          {researchNotice && (
            <div
              role="status"
              className="mt-5 rounded-xl border border-[var(--amber)]/35 bg-[var(--amber)]/10 px-4 py-3 text-xs leading-5 text-[#70552d]"
            >
              {researchNotice}
            </div>
          )}
          <div className="mt-5">
            <ExternalResearchList sources={researchSources} />
          </div>
        </section>
      </div>

      <aside className="lg:sticky lg:top-6">
        <FeedbackControls idea={feedback} />
      </aside>
    </div>
  );
}
