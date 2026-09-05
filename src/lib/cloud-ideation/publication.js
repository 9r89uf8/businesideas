// The same publication fields used by the API finalizer. Model-only fields,
// candidate IDs, and runtime claims never become database idea attributes.
const IDEA_FIELDS = [
  "title", "target_customer", "problem", "offer", "why_pay", "why_now",
  "initial_price", "differentiation", "speed_to_first_revenue", "validation_plan",
  "product_spec", "hard_filter_checks", "risks", "assumptions", "evidence_score",
  "fingerprint", "fingerprint_hash", "embedding",
];

export function cloudPublicationRows({ accepted, sources, payload, posts }) {
  const postsById = new Map(posts.map((post) => [post.post_id, post]));
  const candidatesById = new Map(payload.candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const ideas = accepted.map((idea, index) => ({
    rank: index + 1,
    ...Object.fromEntries(IDEA_FIELDS.map((field) => [field, idea[field]])),
  }));
  const xSources = accepted.flatMap((idea) => idea.source_post_ids.map((postId) => {
    const source = postsById.get(postId);
    const candidate = candidatesById.get(idea.candidate_id);
    if (!source?.author_id || candidate?.source_post?.post_id !== postId) {
      throw new Error("A cloud publication source does not belong to its candidate.");
    }
    return {
      fingerprint_hash: idea.fingerprint_hash,
      post_id: postId,
      signal_type: source.signal_type || null,
      evidence_summary: source.signal_summary || source.problem ||
        candidate.selected_idea.problem_or_opportunity || candidate.selected_idea.product,
    };
  }));
  const acceptedSourceIds = new Set(accepted.flatMap((idea) => idea.research_source_ids));
  const researchSources = sources.filter((source) => acceptedSourceIds.has(source.source_id));
  const ideaResearchSources = accepted.flatMap((idea) => {
    const claimsBySource = new Map(idea.research_source_ids.map((sourceId) => [sourceId, []]));
    for (const mapping of idea.claim_source_map) {
      for (const sourceId of mapping.research_source_ids) {
        const claims = claimsBySource.get(sourceId);
        if (claims && !claims.includes(mapping.claim)) claims.push(mapping.claim);
      }
    }
    return [...claimsBySource].map(([sourceId, supportedClaims]) => ({
      fingerprint_hash: idea.fingerprint_hash, source_id: sourceId, supported_claims: supportedClaims,
    }));
  });
  return { ideas, xSources, researchSources, ideaResearchSources };
}

export function cloudRunUsage(jobs, usage = {}) {
  return {
    ...usage,
    chatgpt_cloud: {
      provider: "chatgpt_cloud", model_verified: false, token_usage: "unavailable",
      jobs: jobs.map((job) => ({
        job_id: job.id, kind: job.kind,
        requested_model: job.requested_model,
        requested_reasoning: job.requested_reasoning,
        status: job.status,
      })),
    },
  };
}
