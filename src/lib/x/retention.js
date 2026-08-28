import "server-only";

import { normalizeXId } from "./client.js";
import { lookupPosts } from "./lookup-posts.js";

const RAW_CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const EVIDENCE_REFRESH_MS = 24 * 60 * 60 * 1_000;
const DATABASE_BATCH_SIZE = 100;
const SOURCE_PAGE_SIZE = 1_000;

function chunks(values, size = DATABASE_BATCH_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function throwDatabaseError(error, operation) {
  if (error) {
    const failure = new Error(`Database operation failed while ${operation}.`);
    failure.cause = error;
    throw failure;
  }
}

function normalizePostIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) =>
    normalizeXId(id, "X post ID"),
  ))];
}

function canonicalPostRow(post, ownerId, now, checked) {
  return {
    x_post_id: post.id,
    owner_id: ownerId,
    author_id: post.author_id,
    author_username: post.author_username,
    text: post.text,
    url: post.url,
    conversation_id: post.conversation_id,
    language: post.lang,
    x_created_at: post.created_at,
    availability: "available",
    last_seen_at: now,
    ...(checked ? { last_checked_at: now } : {}),
  };
}

async function clearEvidenceExcerpts(db, ownerId, ids) {
  for (const batch of chunks(normalizePostIds(ids))) {
    const { error } = await db
      .from("run_posts")
      .update({ evidence_excerpt: null })
      .eq("owner_id", ownerId)
      .in("post_id", batch);
    throwDatabaseError(error, "clearing stale evidence excerpts");
  }
}

async function loadExistingPosts(db, ownerId, postIds) {
  const rows = [];

  for (const batch of chunks(postIds)) {
    const { data, error } = await db
      .from("posts")
      .select("x_post_id, text")
      .eq("owner_id", ownerId)
      .in("x_post_id", batch);
    throwDatabaseError(error, "loading stored evidence posts");
    rows.push(...(data || []));
  }

  return rows;
}

export function getChangedPostTextIds(existingPosts, refreshedPosts) {
  const priorTextById = new Map(
    (existingPosts || []).map((post) => [post.x_post_id, post.text]),
  );

  return (refreshedPosts || [])
    .filter((post) =>
      priorTextById.has(post.id) && priorTextById.get(post.id) !== post.text,
    )
    .map((post) => post.id);
}

export async function upsertCurrentPosts({
  db,
  ownerId,
  now,
  posts,
  checked = false,
  existingPosts,
}) {
  const currentPosts = posts || [];
  if (!currentPosts.length) return [];

  const storedPosts = existingPosts || await loadExistingPosts(
    db,
    ownerId,
    currentPosts.map((post) => post.id),
  );
  const changedIds = getChangedPostTextIds(storedPosts, currentPosts);
  // Invalidate quotes before replacing their source text. If the subsequent
  // upsert fails, a retry can safely repeat both operations without ever
  // leaving an old quote attached to newly stored text.
  await clearEvidenceExcerpts(db, ownerId, changedIds);
  const { error } = await db
    .from("posts")
    .upsert(
      currentPosts.map((post) =>
        canonicalPostRow(post, ownerId, now, checked),
      ),
      { onConflict: "x_post_id", ignoreDuplicates: false },
    );
  throwDatabaseError(error, "saving current X posts");
  return changedIds;
}

/**
 * Saves one successful X lookup and reconciles every stored exact excerpt.
 * Changed or confirmed-unavailable content loses its old quote immediately;
 * ambiguous omissions are marked unknown and remain eligible for a later retry.
 */
export async function applyEvidenceLookupResult({
  db,
  ownerId,
  now,
  existingPosts,
  result,
}) {
  const refreshedPosts = result?.posts || [];
  const unavailableIds = normalizePostIds(
    result?.unavailableIds || result?.missingIds || [],
  );
  const unknownIds = normalizePostIds(result?.unknownIds || []);
  const changedIds = await upsertCurrentPosts({
    db,
    ownerId,
    now,
    posts: refreshedPosts,
    checked: true,
    existingPosts,
  });
  await clearEvidenceExcerpts(db, ownerId, unavailableIds);

  for (const batch of chunks(unavailableIds)) {
    const { error } = await db
      .from("posts")
      .update({
        availability: "unavailable",
        text: null,
        last_checked_at: now,
      })
      .eq("owner_id", ownerId)
      .in("x_post_id", batch);
    throwDatabaseError(error, "marking unavailable evidence posts");
  }

  for (const batch of chunks(unknownIds)) {
    const { error } = await db
      .from("posts")
      .update({ availability: "unknown" })
      .eq("owner_id", ownerId)
      .in("x_post_id", batch);
    throwDatabaseError(error, "marking unverified evidence posts");
  }

  return { changedIds, unavailableIds, unknownIds };
}

export async function refreshPostIds({
  db,
  ownerId,
  postIds,
  now = new Date().toISOString(),
  existingPosts,
  lookup = lookupPosts,
}) {
  const normalizedIds = normalizePostIds(postIds);
  if (!normalizedIds.length) {
    return {
      posts: [],
      missingIds: [],
      unavailableIds: [],
      unknownIds: [],
      errors: [],
      meta: { requestedCount: 0, resultCount: 0, batchesFetched: 0 },
    };
  }

  const storedPosts = existingPosts ||
    await loadExistingPosts(db, ownerId, normalizedIds);
  const result = await lookup({ ids: normalizedIds });
  await applyEvidenceLookupResult({
    db,
    ownerId,
    now,
    existingPosts: storedPosts,
    result,
  });
  return result;
}

export async function purgeExpiredRawContent(db, ownerId, now) {
  const cutoff = new Date(
    new Date(now).getTime() - RAW_CONTENT_RETENTION_MS,
  ).toISOString();
  const { data: expiredPosts, error: selectError } = await db
    .from("posts")
    .select("x_post_id")
    .eq("owner_id", ownerId)
    .lt("x_created_at", cutoff)
    .not("text", "is", null)
    .limit(5_000);
  throwDatabaseError(selectError, "finding expired X content");

  const ids = (expiredPosts || []).map((post) => post.x_post_id);
  await clearEvidenceExcerpts(db, ownerId, ids);

  for (const batch of chunks(ids)) {
    const { error } = await db
      .from("posts")
      .update({ text: null })
      .eq("owner_id", ownerId)
      .in("x_post_id", batch);
    throwDatabaseError(error, "expiring raw X content");
  }
}

/**
 * Reads every idea-source page instead of repeatedly selecting the same first
 * 5,000 links. Duplicate source links are collapsed before stale-post checks.
 */
export async function loadRetainedEvidenceSourceIds(db, ownerId) {
  const ids = new Set();

  for (let offset = 0; ; offset += SOURCE_PAGE_SIZE) {
    const { data, error } = await db
      .from("idea_sources")
      .select("idea_id, post_id")
      .eq("owner_id", ownerId)
      .order("post_id", { ascending: true })
      .order("idea_id", { ascending: true })
      .range(offset, offset + SOURCE_PAGE_SIZE - 1);
    throwDatabaseError(error, "loading retained evidence links");

    const page = data || [];
    for (const link of page) ids.add(link.post_id);
    if (page.length < SOURCE_PAGE_SIZE) break;
  }

  return [...ids];
}

export async function refreshRetainedEvidence(db, ownerId, now) {
  const refreshCutoff = new Date(
    new Date(now).getTime() - EVIDENCE_REFRESH_MS,
  ).toISOString();
  const sourceIds = await loadRetainedEvidenceSourceIds(db, ownerId);
  if (!sourceIds.length) return;

  const stalePosts = [];
  for (const batch of chunks(sourceIds)) {
    const { data, error } = await db
      .from("posts")
      .select("x_post_id, text")
      .eq("owner_id", ownerId)
      .in("x_post_id", batch)
      .not("text", "is", null)
      .or(`last_checked_at.is.null,last_checked_at.lt.${refreshCutoff}`);
    throwDatabaseError(error, "finding evidence posts to refresh");
    stalePosts.push(...(data || []));
  }

  if (!stalePosts.length) return;
  await refreshPostIds({
    db,
    ownerId,
    postIds: stalePosts.map((post) => post.x_post_id),
    now,
    existingPosts: stalePosts,
  });
}
