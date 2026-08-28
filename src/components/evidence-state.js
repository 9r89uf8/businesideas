export function buildEvidenceSources({
  sourceRows,
  posts,
  runPosts,
  verificationTemporarilyUnavailable = false,
}) {
  const postsById = new Map(
    (Array.isArray(posts) ? posts : []).map((post) => [post.x_post_id, post]),
  );
  const excerptsById = new Map(
    (Array.isArray(runPosts) ? runPosts : []).map((post) => [
      post.post_id,
      post.evidence_excerpt,
    ]),
  );

  return (Array.isArray(sourceRows) ? sourceRows : []).map((source) => {
    const storedPost = postsById.get(source.post_id) || null;
    const temporarilyUnverified =
      verificationTemporarilyUnavailable &&
      storedPost?.availability !== "unavailable";
    const post = storedPost
      ? {
          ...storedPost,
          availability: temporarilyUnverified
            ? "unknown"
            : storedPost.availability,
        }
      : { availability: "unknown" };
    const excerpt = excerptsById.get(source.post_id) || null;

    return {
      ...source,
      exactExcerpt:
        !temporarilyUnverified && excerpt && post.text?.includes(excerpt)
          ? excerpt
          : null,
      post,
      temporarilyUnverified,
    };
  });
}
