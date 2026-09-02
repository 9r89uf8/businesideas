export default function EmptyReport({ hasRun = false, failed = false }) {
  return (
    <section className="panel relative overflow-hidden px-6 py-12 text-center sm:px-10">
      <div className="absolute left-1/2 top-0 h-px w-40 -translate-x-1/2 bg-gradient-to-r from-transparent via-[var(--moss)] to-transparent" />
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--moss)]/8 text-[var(--moss)]">
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6" fill="none">
          <path d="M5 7h14M7 12h10M9 17h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </span>
      <h2 className="mt-5 text-xl font-semibold tracking-[-0.03em]">
        {failed
          ? "The last report could not be completed."
          : hasRun
            ? "No sufficiently supported new opportunity was found."
            : "Your first evidence report will appear here."}
      </h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--ink-soft)]">
        {failed
          ? "Review the run error above, then start a fresh run once the upstream issue is resolved."
          : hasRun
            ? "That is a valid result: no source post produced a distinct candidate strong enough to clear the evidence gates today."
            : "Start a manual run to filter recent AI discussions, generate candidates independently, and validate only the strongest ideas."}
      </p>
    </section>
  );
}
