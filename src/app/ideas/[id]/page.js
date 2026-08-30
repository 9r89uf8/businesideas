import Link from "next/link";
import { notFound } from "next/navigation";
import { buildEvidenceSources } from "@/components/evidence-state";
import IdeaDetail from "@/components/idea-detail";
import { requireOwner } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { refreshPostIds } from "@/lib/x/retention";

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function refreshEvidence(ownerId, postIds) {
  const db = createSupabaseAdminClient();
  return refreshPostIds({ db, ownerId, postIds });
}

export default async function IdeaDetailPage({ params }) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  const { ownerId, supabase } = await requireOwner();
  const { data: idea, error } = await supabase
    .from("ideas")
    .select("id, run_id, rank, title, target_customer, problem, offer, why_pay, why_now, initial_price, differentiation, speed_to_first_revenue, validation_plan, product_spec, hard_filter_checks, risks, assumptions, evidence_score, status, feedback_reason, feedback_note")
    .eq("owner_id", ownerId)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return (
      <main className="shell py-12">
        <section className="panel border-[var(--rose)]/30 p-6 text-sm leading-6 text-[#7d433c]">
          This idea could not be loaded because the database request failed. Refresh once the connection is healthy.
        </section>
      </main>
    );
  }
  if (!idea) notFound();

  const { data: sourceRows, error: sourceError } = await supabase
    .from("idea_sources")
    .select("post_id, signal_type, evidence_summary")
    .eq("owner_id", ownerId)
    .eq("idea_id", id);

  const postIds = (sourceRows || []).map((source) => source.post_id);
  let sources = [];
  let evidenceNotice = sourceError
    ? "The saved evidence links could not be loaded from the database. The opportunity hypothesis and feedback controls remain available."
    : null;
  let verificationTemporarilyUnavailable = false;

  if (postIds.length) {
    try {
      await refreshEvidence(ownerId, postIds);
    } catch {
      verificationTemporarilyUnavailable = true;
      evidenceNotice =
        "X could not verify the source posts right now. Saved evidence rows remain visible and are marked temporarily unverified.";
    }
    const [postsResult, runPostsResult] = await Promise.all([
      supabase
        .from("posts")
        .select("x_post_id, author_username, text, url, x_created_at, availability")
        .eq("owner_id", ownerId)
        .in("x_post_id", postIds),
      supabase
        .from("run_posts")
        .select("post_id, evidence_excerpt")
        .eq("owner_id", ownerId)
        .eq("run_id", idea.run_id)
        .in("post_id", postIds),
    ]);

    if (postsResult.error || runPostsResult.error) {
      evidenceNotice =
        "Some saved evidence details could not be loaded from the database. Evidence links remain listed and can be verified after the connection recovers.";
    }

    sources = buildEvidenceSources({
      sourceRows,
      posts: postsResult.data,
      runPosts: runPostsResult.data,
      verificationTemporarilyUnavailable:
        verificationTemporarilyUnavailable || Boolean(postsResult.error),
    });
  }

  const { data: researchLinks, error: researchLinksError } = await supabase
    .from("idea_research_sources")
    .select("research_source_id, supported_claims")
    .eq("owner_id", ownerId)
    .eq("idea_id", id);
  const researchSourceIds = (researchLinks || []).map(
    (link) => link.research_source_id,
  );
  let researchSources = [];
  let researchNotice = researchLinksError
    ? "The external-research links could not be loaded from the database."
    : null;

  if (researchSourceIds.length) {
    const { data: sourceDetails, error: researchSourcesError } = await supabase
      .from("research_sources")
      .select(
        "id, source_id, url, title, publisher, published_at, accessed_at, source_type, supported_claims",
      )
      .eq("owner_id", ownerId)
      .in("id", researchSourceIds);

    if (researchSourcesError) {
      researchNotice =
        "Some external-research details could not be loaded from the database.";
    } else {
      const linksBySourceId = new Map(
        (researchLinks || []).map((link) => [
          link.research_source_id,
          link.supported_claims || [],
        ]),
      );
      researchSources = (sourceDetails || []).map((source) => ({
        ...source,
        supported_claims:
          linksBySourceId.get(source.id)?.length > 0
            ? linksBySourceId.get(source.id)
            : source.supported_claims,
      }));
    }
  }

  const displayIdea = {
    target_customer: idea.target_customer,
    problem: idea.problem,
    offer: idea.offer,
    why_pay: idea.why_pay,
    why_now: idea.why_now,
    initial_price: idea.initial_price,
    differentiation: idea.differentiation,
    speed_to_first_revenue: idea.speed_to_first_revenue,
    validation_plan: idea.validation_plan,
    product_spec: idea.product_spec,
    hard_filter_checks: idea.hard_filter_checks,
    risks: idea.risks,
    assumptions: idea.assumptions,
  };
  const feedback = {
    id: idea.id,
    status: idea.status,
    feedback_reason: idea.feedback_reason,
    feedback_note: idea.feedback_note,
  };

  return (
    <main className="shell py-9 sm:py-12">
      <Link href="/ideas" className="focus-ring inline-flex rounded-md text-xs font-bold text-[var(--moss)] hover:underline">← Back to archive</Link>
      <div className="mt-5 flex flex-col justify-between gap-5 border-b border-[var(--line)] pb-7 sm:flex-row sm:items-end">
        <div className="max-w-4xl">
          <p className="eyebrow">Opportunity hypothesis #{idea.rank}</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-[-0.055em] sm:text-5xl">{idea.title}</h1>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-xs text-[var(--ink-soft)]">Evidence strength</p>
          <p className="mt-1 font-mono text-3xl font-semibold text-[var(--moss)]">{idea.evidence_score}<span className="text-base text-[var(--ink-soft)]">/100</span></p>
        </div>
      </div>
      <div className="mt-6">
        <IdeaDetail
          idea={displayIdea}
          sources={sources}
          researchSources={researchSources}
          feedback={feedback}
          evidenceNotice={evidenceNotice}
          researchNotice={researchNotice}
        />
      </div>
    </main>
  );
}
