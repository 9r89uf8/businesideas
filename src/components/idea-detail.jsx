import EvidenceList from "@/components/evidence-list";
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

export default function IdeaDetail({ idea, sources, feedback, evidenceNotice }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="space-y-5">
        <section className="panel p-5 sm:p-7">
          <div className="grid gap-7 sm:grid-cols-2">
            <Section label="Customer">{idea.target_customer}</Section>
            <Section label="Price assumption">{idea.initial_price || "Not specified"}</Section>
            <Section label="Observed problem">{idea.problem}</Section>
            <Section label="Sellable first offer">{idea.offer}</Section>
          </div>
        </section>

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
      </div>

      <aside className="lg:sticky lg:top-6">
        <FeedbackControls idea={feedback} />
      </aside>
    </div>
  );
}
