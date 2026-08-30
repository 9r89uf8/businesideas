function formatDate(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function humanize(value) {
  return typeof value === "string"
    ? value.replaceAll("_", " ")
    : "external source";
}

export default function ExternalResearchList({ sources }) {
  if (!sources?.length) {
    return (
      <p className="text-sm text-[var(--ink-soft)]">
        No external research sources were attached to this idea.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {sources.map((source, index) => {
        const published = formatDate(source.published_at);
        const accessed = formatDate(source.accessed_at);

        return (
          <article
            key={source.id || source.source_id || source.url}
            className="rounded-2xl border border-[var(--line)] bg-white/55 p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--moss)] font-mono text-[0.62rem] font-bold text-white">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold leading-5 text-[var(--ink)]">
                    {source.title}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-[var(--ink-soft)]">
                    {source.publisher || "Publisher not recorded"}
                    {published ? ` · Published ${published}` : ""}
                    {accessed ? ` · Checked ${accessed}` : ""}
                  </p>
                </div>
              </div>
              <span className="rounded-full bg-[var(--amber)]/13 px-2.5 py-1 text-[0.64rem] font-bold uppercase tracking-wide text-[#77521d]">
                {humanize(source.source_type)}
              </span>
            </div>

            {source.supported_claims?.length > 0 && (
              <div className="mt-4">
                <p className="eyebrow">Claims this source supports</p>
                <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[var(--ink-soft)]">
                  {source.supported_claims.map((claim) => (
                    <li key={claim} className="flex gap-2">
                      <span
                        aria-hidden="true"
                        className="mt-2 size-1 shrink-0 rounded-full bg-[var(--moss)]"
                      />
                      <span>{claim}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring mt-4 inline-flex rounded-md text-xs font-bold text-[var(--moss)] hover:underline"
            >
              Open source ↗
            </a>
          </article>
        );
      })}
    </div>
  );
}
