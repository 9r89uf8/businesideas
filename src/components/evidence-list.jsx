function formatDate(value) {
  if (!value) return "Date unavailable";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export default function EvidenceList({ sources }) {
  if (!sources?.length) {
    return <p className="text-sm text-[var(--ink-soft)]">No source posts are available.</p>;
  }

  return (
    <div className="space-y-3">
      {sources.map((source, index) => {
        const post = source.post;
        const available = post?.availability === "available";
        const unavailable = post?.availability === "unavailable";
        const temporarilyUnverified = Boolean(source.temporarilyUnverified);
        const exactText = available ? source.exactExcerpt || post?.text : null;

        return (
          <article key={source.post_id} className="rounded-2xl border border-[var(--line)] bg-white/55 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="grid size-6 place-items-center rounded-full bg-[var(--ink)] font-mono text-[0.62rem] font-bold text-white">{index + 1}</span>
                <span className="font-semibold">{post?.author_username ? `@${post.author_username}` : "Author unavailable"}</span>
                <span className="text-[var(--ink-soft)]">{formatDate(post?.x_created_at)}</span>
              </div>
              <span className={`rounded-full px-2.5 py-1 text-[0.64rem] font-bold uppercase tracking-wide ${available ? "bg-[var(--moss)]/8 text-[var(--moss)]" : "bg-[var(--rose)]/10 text-[#88483f]"}`}>
                {available
                  ? source.signal_type || "evidence"
                  : unavailable
                    ? "unavailable"
                    : temporarilyUnverified
                      ? "temporarily unverified"
                      : "not verified"}
              </span>
            </div>

            {exactText ? (
              <blockquote className="mt-4 border-l-2 border-[var(--moss-bright)] pl-4 text-sm leading-6 text-[var(--ink)]">
                “{exactText}”
              </blockquote>
            ) : (
              <p className="mt-4 text-sm italic leading-6 text-[var(--ink-soft)]">
                {available
                  ? "The raw excerpt has expired under the 30-day retention policy."
                  : unavailable
                    ? "This post is no longer available from X."
                    : temporarilyUnverified
                      ? "X could not verify this post right now. The saved evidence link will be checked again."
                      : "X could not verify this post right now. It will be checked again."}
              </p>
            )}

            <p className="mt-3 text-xs leading-5 text-[var(--ink-soft)]">
              <span className="font-bold text-[var(--ink)]">Signal summary:</span> {source.evidence_summary}
            </p>

            {available && post?.url && (
              <a
                href={post.url}
                target="_blank"
                rel="noreferrer"
                className="focus-ring mt-3 inline-flex rounded-md text-xs font-bold text-[var(--moss)] hover:underline"
              >
                Open current post on X ↗
              </a>
            )}
          </article>
        );
      })}
    </div>
  );
}
