import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { POST_QUALITY } from "@/lib/config";

export const metadata = { title: "Source feed" };
export const dynamic = "force-dynamic";

const SOURCE_FILTERS = new Set(["all", "followed", "topic"]);
const VIEW_FILTERS = new Set(["all", "selected", "signals"]);

function clean(value, maximum = 100) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function formatDate(value, includeTime = false) {
  if (!value) return "Unknown date";

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(value));
}

function compactNumber(value) {
  if (value === undefined || value === null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "—";
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function runLabel(run) {
  const date = formatDate(run.completed_at || run.created_at, true);
  return `${date} · ${run.status.replaceAll("_", " ")}`;
}

function sourceLabel(channel) {
  return channel === "followed" ? "Followed account" : "Topic discovery";
}

function PostCard({ snapshot, rankingVersion }) {
  const post = snapshot.post;
  const metrics = snapshot.metrics || {};
  const qualityMetrics = [
    ["Views", metrics.impression_count, "X post impressions; not unique viewers"],
    ["Comments", metrics.reply_count],
    ["Likes", metrics.like_count],
    ["Saves", metrics.bookmark_count],
  ];
  const usesViewFirstRanking =
    rankingVersion === POST_QUALITY.version ||
    Object.hasOwn(metrics, "impression_count");

  return (
    <article className="panel overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-5 py-3">
        <span className={`rounded-full px-2.5 py-1 text-[0.68rem] font-bold ${
          snapshot.source_channel === "followed"
            ? "bg-[var(--moss-bright)]/30 text-[#2b4d3f]"
            : "bg-[var(--ink)]/7 text-[var(--ink-soft)]"
        }`}>
          {sourceLabel(snapshot.source_channel)}
        </span>
        {snapshot.selected_for_ai && (
          <span className="rounded-full bg-[var(--amber)]/20 px-2.5 py-1 text-[0.68rem] font-bold text-[#77521d]">
            Sent to signal model
          </span>
        )}
        {snapshot.relevant === true && (
          <span className="rounded-full bg-[var(--moss)]/10 px-2.5 py-1 text-[0.68rem] font-bold text-[var(--moss)]">
            Commercial signal
          </span>
        )}
        {snapshot.relevant === false && (
          <span className="rounded-full bg-[var(--rose)]/10 px-2.5 py-1 text-[0.68rem] font-bold text-[#88483f]">
            Screened out
          </span>
        )}
      </div>

      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-semibold tracking-[-0.02em]">
              {post?.author_username ? `@${post.author_username}` : "Unknown X author"}
            </p>
            <p className="mt-1 text-xs text-[var(--ink-soft)]">
              {formatDate(post?.x_created_at, true)}
              {post?.availability && post.availability !== "available" ? ` · ${post.availability}` : ""}
            </p>
          </div>
          {post?.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="focus-ring rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-xs font-bold text-[var(--moss)] hover:border-[var(--moss)]/40"
            >
              Open on X ↗
            </a>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-[var(--line)] bg-white/70 px-4 py-3">
          <p className="eyebrow">Stored X text</p>
          {post?.text ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{post.text}</p>
          ) : (
            <p className="mt-2 text-sm italic leading-6 text-[var(--ink-soft)]">
              Raw text is unavailable or has passed the 30-day retention window.
            </p>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {qualityMetrics.map(([label, value, title]) => (
            <div key={label} className="rounded-xl bg-[var(--ink)]/[0.035] px-3 py-2.5">
              <dt title={title} className="text-[0.66rem] font-bold uppercase tracking-[0.09em] text-[var(--ink-soft)]">{label}</dt>
              <dd className="mt-1 font-mono text-sm font-bold">{compactNumber(value)}</dd>
            </div>
          ))}
        </dl>

        {snapshot.selected_for_ai && snapshot.relevant !== null && (
          <div className="mt-4 border-t border-[var(--line)] pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">Model signal</p>
              {snapshot.signal_type && snapshot.signal_type !== "none" && (
                <span className="font-mono text-[0.68rem] font-bold uppercase tracking-[0.08em] text-[var(--ink-soft)]">
                  {snapshot.signal_type.replaceAll("_", " ")}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
              {snapshot.signal_summary || (snapshot.relevant ? "Relevant signal; no summary was stored." : "The model did not find a usable commercial signal.")}
            </p>
            {snapshot.target_customer && (
              <p className="mt-2 text-xs leading-5">
                <span className="font-bold">Possible customer:</span> {snapshot.target_customer}
              </p>
            )}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-3 text-[0.68rem] text-[var(--ink-soft)]">
          <span>Search position {snapshot.search_position ?? "—"}</span>
          <span>{usesViewFirstRanking ? "View-first score" : "Legacy score"} {Number.isFinite(snapshot.deterministic_score) ? snapshot.deterministic_score.toFixed(2) : "—"}</span>
        </div>
      </div>
    </article>
  );
}

export default async function PostsPage({ searchParams }) {
  const params = await searchParams;
  const requestedSource = clean(params?.source, 20);
  const requestedView = clean(params?.view, 20);
  const source = SOURCE_FILTERS.has(requestedSource) ? requestedSource : "all";
  const view = VIEW_FILTERS.has(requestedView) ? requestedView : "all";
  const { ownerId, supabase } = await requireOwner();

  const { data: runs, error: runsError } = await supabase
    .from("runs")
    .select("id, status, stage, counts, settings_snapshot, created_at, completed_at")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(20);

  const runList = runs || [];
  const requestedRun = clean(params?.run, 50);
  const selectedRun = runList.find((run) => run.id === requestedRun) || runList[0] || null;
  let snapshots = [];
  let pageError = runsError;

  if (selectedRun && !pageError) {
    let snapshotQuery = supabase
      .from("run_posts")
      .select("post_id, search_position, metrics, deterministic_score, selected_for_ai, source_channel, relevant, signal_type, target_customer, signal_summary")
      .eq("owner_id", ownerId)
      .eq("run_id", selectedRun.id);

    if (source !== "all") snapshotQuery = snapshotQuery.eq("source_channel", source);
    if (view === "selected") snapshotQuery = snapshotQuery.eq("selected_for_ai", true);
    if (view === "signals") snapshotQuery = snapshotQuery.eq("relevant", true);

    const snapshotResult = await snapshotQuery
      .order("deterministic_score", { ascending: false, nullsFirst: false })
      .order("search_position", { ascending: true })
      .limit(500);

    pageError = snapshotResult.error;
    snapshots = snapshotResult.data || [];

    if (snapshots.length && !pageError) {
      const { data: posts, error: postsError } = await supabase
        .from("posts")
        .select("x_post_id, author_username, text, url, x_created_at, availability")
        .eq("owner_id", ownerId)
        .in("x_post_id", snapshots.map((snapshot) => snapshot.post_id));
      pageError = postsError;
      const postsById = new Map((posts || []).map((post) => [post.x_post_id, post]));
      snapshots = snapshots.map((snapshot) => ({ ...snapshot, post: postsById.get(snapshot.post_id) || null }));
    }
  }

  const counts = selectedRun?.counts || {};
  const followedSelected = Number(counts.sent_to_luna_followed) || 0;
  const topicSelected = Number(counts.sent_to_luna_topic) || 0;

  return (
    <main className="shell py-9 sm:py-12">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <p className="eyebrow">Source feed</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">See what the research actually read.</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">
            Inspect stored X posts, view-first quality metrics, selection decisions, and model-added signals. Raw post text is retained for up to 30 days.
          </p>
        </div>
        <Link href="/settings#x-sources" className="focus-ring rounded-xl bg-[var(--ink)] px-4 py-3 text-sm font-bold text-white">
          Manage followed accounts →
        </Link>
      </div>

      <form className="panel mt-8 grid gap-3 p-4 md:grid-cols-[minmax(15rem,1fr)_12rem_12rem_auto]" action="/posts">
        <label className="text-xs font-bold">
          Research run
          <select name="run" defaultValue={selectedRun?.id || ""} className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal capitalize outline-none">
            {!runList.length && <option value="">No research runs yet</option>}
            {runList.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold">
          Source
          <select name="source" defaultValue={source} className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal outline-none">
            <option value="all">All sources</option>
            <option value="followed">Followed accounts</option>
            <option value="topic">Topic discovery</option>
          </select>
        </label>
        <label className="text-xs font-bold">
          Pipeline view
          <select name="view" defaultValue={view} className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal outline-none">
            <option value="all">All collected posts</option>
            <option value="selected">Sent to signal model</option>
            <option value="signals">Commercial signals</option>
          </select>
        </label>
        <button className="focus-ring self-end rounded-xl bg-[var(--ink)] px-4 py-2.5 text-sm font-bold text-white">Filter</button>
      </form>

      {selectedRun && (
        <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="panel px-4 py-4">
            <p className="font-mono text-2xl font-semibold">{Number(counts.x_returned) || 0}</p>
            <p className="mt-1 text-xs font-semibold text-[var(--ink-soft)]">Collected</p>
          </div>
          <div className="panel px-4 py-4">
            <p className="font-mono text-2xl font-semibold">{followedSelected}</p>
            <p className="mt-1 text-xs font-semibold text-[var(--ink-soft)]">Followed selected</p>
          </div>
          <div className="panel px-4 py-4">
            <p className="font-mono text-2xl font-semibold">{topicSelected}</p>
            <p className="mt-1 text-xs font-semibold text-[var(--ink-soft)]">Topic selected</p>
          </div>
          <div className="panel px-4 py-4">
            <p className="font-mono text-2xl font-semibold">{Number(counts.relevant_signals) || 0}</p>
            <p className="mt-1 text-xs font-semibold text-[var(--ink-soft)]">Signals</p>
          </div>
        </section>
      )}

      <div className="mt-6 flex items-center justify-between gap-4 text-xs text-[var(--ink-soft)]">
        <p>{snapshots.length} {snapshots.length === 1 ? "post" : "posts"} in this view</p>
        {(source !== "all" || view !== "all" || requestedRun) && <Link href="/posts" className="focus-ring rounded-md font-bold text-[var(--moss)] hover:underline">Clear filters</Link>}
      </div>

      {pageError ? (
        <section className="mt-5 rounded-2xl border border-[var(--rose)]/30 bg-[var(--rose)]/8 px-5 py-4 text-sm leading-6 text-[#7d433c]">
          The source feed could not be loaded. Confirm the latest additive Supabase migration has been applied.
        </section>
      ) : snapshots.length ? (
        <section className="mt-4 grid gap-4 lg:grid-cols-2">
          {snapshots.map((snapshot) => (
            <PostCard
              key={snapshot.post_id}
              snapshot={snapshot}
              rankingVersion={selectedRun?.settings_snapshot?.ranking_version}
            />
          ))}
        </section>
      ) : (
        <section className="panel mt-5 px-6 py-14 text-center">
          <h2 className="text-xl font-semibold tracking-[-0.03em]">
            {selectedRun ? "No posts match this view." : "No source posts yet."}
          </h2>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            {selectedRun ? "Try a broader filter or inspect another run." : "Posts will appear after the first research run."}
          </p>
        </section>
      )}
    </main>
  );
}
