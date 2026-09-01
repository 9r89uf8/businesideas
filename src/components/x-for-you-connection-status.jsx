const STATE_STYLES = Object.freeze({
  healthy: Object.freeze({
    dot: "bg-[var(--moss)]",
    badge: "bg-[var(--moss)]/8 text-[var(--moss)]",
  }),
  manual_login_required: Object.freeze({
    dot: "bg-[var(--rose)]",
    badge: "bg-[var(--rose)]/10 text-[#88483f]",
  }),
  unknown: Object.freeze({
    dot: "bg-[var(--amber)]",
    badge: "bg-[var(--amber)]/15 text-[#76551f]",
  }),
});

function formatTimestamp(value) {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export default function XForYouConnectionStatus({ status }) {
  const style = STATE_STYLES[status.state] || STATE_STYLES.unknown;

  return (
    <section className="panel px-5 py-5 sm:px-6" aria-live="polite">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
        <div className="flex items-start gap-4">
          <span className={`mt-1.5 size-3 shrink-0 rounded-full ${style.dot}`} />
          <div>
            <p className="eyebrow">X For You connection</p>
            <div className="mt-2 flex flex-wrap items-center gap-2.5">
              <h2 className="text-xl font-semibold tracking-[-0.035em]">
                Cloud collector
              </h2>
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${style.badge}`}>
                {status.label}
              </span>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">
              {status.detail}
            </p>
            {status.state === "manual_login_required" && (
              <p className="mt-2 text-sm font-semibold text-[#88483f]">
                Run <code className="font-mono">npm run x:for-you:login</code> from the approved operator environment.
              </p>
            )}
          </div>
        </div>

        <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-2 text-xs sm:min-w-[20rem]">
          <div>
            <dt className="font-semibold text-[var(--ink-soft)]">Last checked</dt>
            <dd className="mt-1 font-mono font-bold text-[var(--ink)]">
              {formatTimestamp(status.checkedAt)}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-[var(--ink-soft)]">Last success</dt>
            <dd className="mt-1 font-mono font-bold text-[var(--ink)]">
              {formatTimestamp(status.successAt)}
            </dd>
          </div>
          {status.errorCode && (
            <div className="col-span-2">
              <dt className="font-semibold text-[var(--ink-soft)]">Last check code</dt>
              <dd className="mt-1 font-mono font-bold text-[var(--ink)]">
                {status.errorCode}
              </dd>
            </div>
          )}
        </dl>
      </div>
    </section>
  );
}
