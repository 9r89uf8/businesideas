import Link from "next/link";

const statusStyle = {
  new: "bg-[#e8efe8] text-[var(--moss)]",
  saved: "bg-[#e8efe8] text-[var(--moss)]",
  rejected: "bg-[#f5e7e4] text-[#88483f]",
  testing: "bg-[#f8ecd5] text-[#805d23]",
  validated: "bg-[var(--moss-bright)]/35 text-[var(--moss)]",
  archived: "bg-black/5 text-[var(--ink-soft)]",
};

function sentence(value, fallback = "Not specified") {
  return value?.trim() || fallback;
}

export default function IdeaCard({ idea, compact = false }) {
  const sourceCount = idea.sourceCount ?? idea.idea_sources?.length ?? 0;

  return (
    <article className="panel group flex h-full flex-col p-5 transition-transform hover:-translate-y-0.5 sm:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-[var(--ink-soft)]">#{idea.rank}</span>
          <span className={`rounded-full px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wide ${statusStyle[idea.status] || statusStyle.new}`}>
            {idea.status}
          </span>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--ink-soft)]">
          <span className="size-1.5 rounded-full bg-[var(--moss)]" />
          {sourceCount} sources
        </span>
      </div>

      <p className="eyebrow mt-6">{sentence(idea.target_customer)}</p>
      <h3 className="mt-2 text-xl font-semibold leading-7 tracking-[-0.035em] sm:text-[1.35rem]">
        {idea.title}
      </h3>
      <p className="mt-3 text-sm leading-6 text-[var(--ink-soft)]">
        {compact ? sentence(idea.problem) : sentence(idea.offer)}
      </p>

      <div className="mt-auto pt-6">
        <div className="mb-4 flex items-center justify-between border-t border-[var(--line)] pt-4 text-xs">
          <span className="text-[var(--ink-soft)]">Evidence strength</span>
          <span className="font-mono font-bold text-[var(--moss)]">{idea.evidence_score}/100</span>
        </div>
        <Link
          href={`/ideas/${idea.id}`}
          className="focus-ring inline-flex items-center gap-2 rounded-lg text-sm font-bold text-[var(--ink)] decoration-[var(--moss-bright)] decoration-2 underline-offset-4 hover:underline"
        >
          Review the hypothesis <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
        </Link>
      </div>
    </article>
  );
}
