import IdeaCard from "@/components/idea-card";
import { requireOwner } from "@/lib/auth";

export const metadata = { title: "Idea archive" };
export const dynamic = "force-dynamic";

const statusOptions = ["all", "new", "saved", "testing", "validated", "rejected", "archived"];

function clean(value, maximum = 100) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

export default async function IdeasPage({ searchParams }) {
  const params = await searchParams;
  const query = clean(params?.q);
  const requestedStatus = clean(params?.status, 20);
  const status = statusOptions.includes(requestedStatus) ? requestedStatus : "all";
  const customer = clean(params?.customer);
  const order = params?.order === "oldest" ? "oldest" : "newest";
  const { ownerId, supabase } = await requireOwner();

  let ideasQuery = supabase
    .from("ideas")
    .select("id, rank, title, target_customer, problem, offer, product_spec, evidence_score, status, created_at", { count: "exact" })
    .eq("owner_id", ownerId);

  if (status !== "all") ideasQuery = ideasQuery.eq("status", status);
  if (customer) ideasQuery = ideasQuery.eq("target_customer", customer);
  if (query) {
    const safeSearch = query
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (safeSearch) {
      const pattern = `%${safeSearch}%`;
      ideasQuery = ideasQuery.or(
        `title.ilike.${pattern},target_customer.ilike.${pattern},problem.ilike.${pattern},offer.ilike.${pattern}`,
      );
    }
  }

  const [ideasResult, customersResult] = await Promise.all([
    ideasQuery.order("created_at", { ascending: order !== "oldest" }).limit(300),
    supabase
      .from("ideas")
      .select("target_customer")
      .eq("owner_id", ownerId)
      .order("target_customer", { ascending: true })
      .limit(5_000),
  ]);

  const { data, count } = ideasResult;
  let error = ideasResult.error || customersResult.error;

  let ideas = data || [];
  const customers = [...new Set((customersResult.data || []).map((idea) => idea.target_customer).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  if (ideas.length) {
    const { data: sources, error: sourceError } = await supabase
      .from("idea_sources")
      .select("idea_id")
      .eq("owner_id", ownerId)
      .in("idea_id", ideas.map((idea) => idea.id));
    error = error || sourceError;
    const counts = (sources || []).reduce((result, source) => {
      result[source.idea_id] = (result[source.idea_id] || 0) + 1;
      return result;
    }, {});
    ideas = ideas.map((idea) => ({ ...idea, sourceCount: counts[idea.id] || 0 }));
  }

  return (
    <main className="shell py-9 sm:py-12">
      <div>
        <p className="eyebrow">Idea archive</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">Every hypothesis, with its evidence.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ink-soft)]">
          Search prior reports and revisit decisions. Status feedback becomes context for future deduplication and ideation.
        </p>
      </div>

      <form className="panel mt-8 grid gap-3 p-4 md:grid-cols-[minmax(12rem,1fr)_11rem_14rem_9rem_auto]" action="/ideas">
        <label className="text-xs font-bold">
          Search
          <input name="q" defaultValue={query} placeholder="Customer, problem, or offer" className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal outline-none" />
        </label>
        <label className="text-xs font-bold">
          Status
          <select name="status" defaultValue={status} className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal capitalize outline-none">
            {statusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold">
          Customer
          <select name="customer" defaultValue={customer} className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal outline-none">
            <option value="">All customers</option>
            {customers.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label className="text-xs font-bold">
          Order
          <select name="order" defaultValue={order} className="focus-ring mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm font-normal outline-none">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </label>
        <button className="focus-ring self-end rounded-xl bg-[var(--ink)] px-4 py-2.5 text-sm font-bold text-white">Filter</button>
      </form>

      <div className="mt-5 flex items-center justify-between gap-4 text-xs text-[var(--ink-soft)]">
        <p>{count ?? ideas.length} {(count ?? ideas.length) === 1 ? "idea" : "ideas"}{(count ?? 0) > ideas.length ? ` · showing first ${ideas.length}` : ""}</p>
        {(query || customer || status !== "all" || order !== "newest") && <a href="/ideas" className="focus-ring rounded-md font-bold text-[var(--moss)] hover:underline">Clear filters</a>}
      </div>

      {error ? (
        <div className="mt-5 rounded-2xl border border-[var(--rose)]/30 bg-[var(--rose)]/8 px-5 py-4 text-sm text-[#7d433c]">
          The idea archive could not be loaded. Confirm the Supabase migration has been applied.
        </div>
      ) : ideas.length ? (
        <section className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ideas.map((idea) => <IdeaCard key={idea.id} idea={idea} compact />)}
        </section>
      ) : (
        <section className="panel mt-5 px-6 py-14 text-center">
          <h2 className="text-xl font-semibold tracking-[-0.03em]">No ideas match these filters.</h2>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">Try a broader search or return after the next research run.</p>
        </section>
      )}
    </main>
  );
}
