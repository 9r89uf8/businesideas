import "server-only";

import {
  X_EXPANSIONS,
  X_MEDIA_FIELDS,
  X_POST_FIELDS,
  X_USER_FIELDS,
  indexMedia,
  indexUsers,
  normalizeXId,
  normalizeXPost,
  xRequest,
} from "./client.js";

const LOOKUP_BATCH_LIMIT = 100;

function normalizeIds(ids) {
  if (!Array.isArray(ids)) {
    throw new TypeError("ids must be an array.");
  }

  const uniqueIds = [];
  const seenIds = new Set();

  for (const value of ids) {
    const id = normalizeXId(value, "X post ID");
    if (!seenIds.has(id)) {
      seenIds.add(id);
      uniqueIds.push(id);
    }
  }

  return uniqueIds;
}

function normalizeLookupErrors(errors) {
  if (!Array.isArray(errors)) {
    return [];
  }

  return errors.map((error) => {
    let id = null;
    const statusValue = error?.status;
    const numericStatus = Number(statusValue);
    const hasNumericStatus =
      statusValue !== undefined &&
      statusValue !== null &&
      Number.isInteger(numericStatus);
    const type = typeof error?.type === "string" ? error.type.trim() : "";
    const upstreamTitle =
      typeof error?.title === "string" ? error.title.trim().toLowerCase() : "";
    try {
      if (error?.resource_id !== undefined && error.resource_id !== null) {
        id = normalizeXId(error.resource_id, "X post ID");
      }
    } catch {
      id = null;
    }

    const unavailable =
      numericStatus === 404 ||
      numericStatus === 410 ||
      type.endsWith("/resource-not-found") ||
      (!hasNumericStatus &&
        !type &&
        upstreamTitle === "not found error");

    return {
      id,
      status:
        hasNumericStatus ? numericStatus : null,
      // Do not copy arbitrary upstream error text into logs or API responses.
      title: unavailable ? "Post unavailable" : "X lookup error",
      availability: unavailable ? "unavailable" : "unknown",
    };
  });
}

function readLookupBatch(payload) {
  const hasData = payload?.data !== undefined;
  const hasErrors = Array.isArray(payload?.errors);

  if (!hasData && !hasErrors) {
    throw new Error("X post lookup returned an invalid data payload.");
  }

  if (hasData && !Array.isArray(payload.data)) {
    throw new Error("X post lookup returned an invalid data payload.");
  }

  const usersById = indexUsers(payload?.includes?.users);
  const mediaByKey = indexMedia(payload?.includes?.media);
  const posts = (payload?.data ?? []).map((post) =>
    normalizeXPost(post, usersById, mediaByKey),
  );

  return {
    posts,
    errors: normalizeLookupErrors(payload?.errors),
  };
}

/**
 * Looks up current post versions in endpoint-sized batches. Only explicit
 * resource-not-found errors are treated as unavailable. Other omissions and
 * per-resource errors remain unknown so a transient or authorization problem
 * cannot be mistaken for a deletion.
 */
export async function lookupPosts({
  ids,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const requestedIds = normalizeIds(ids);

  if (requestedIds.length === 0) {
    return {
      posts: [],
      missingIds: [],
      unavailableIds: [],
      unknownIds: [],
      errors: [],
      meta: {
        requestedCount: 0,
        resultCount: 0,
        batchesFetched: 0,
      },
    };
  }

  const postsById = new Map();
  const errors = [];
  let batchesFetched = 0;

  for (let offset = 0; offset < requestedIds.length; offset += LOOKUP_BATCH_LIMIT) {
    const batch = requestedIds.slice(offset, offset + LOOKUP_BATCH_LIMIT);
    const payload = await xRequest("/2/tweets", {
      searchParams: {
        ids: batch.join(","),
        "tweet.fields": X_POST_FIELDS.join(","),
        expansions: X_EXPANSIONS.join(","),
        "user.fields": X_USER_FIELDS.join(","),
        "media.fields": X_MEDIA_FIELDS.join(","),
      },
      fetchImpl,
      signal,
    });
    const result = readLookupBatch(payload);
    batchesFetched += 1;

    for (const post of result.posts) {
      postsById.set(post.id, post);
    }
    errors.push(...result.errors);
  }

  const posts = requestedIds
    .filter((id) => postsById.has(id))
    .map((id) => postsById.get(id));
  const unavailableSet = new Set(
    errors
      .filter((error) => error.id && error.availability === "unavailable")
      .map((error) => error.id),
  );
  const unavailableIds = requestedIds.filter(
    (id) => !postsById.has(id) && unavailableSet.has(id),
  );
  const unknownIds = requestedIds.filter(
    (id) => !postsById.has(id) && !unavailableSet.has(id),
  );

  return {
    posts,
    // Kept as a compatibility alias. "missing" now means confirmed
    // unavailable, never merely omitted from a successful batch response.
    missingIds: unavailableIds,
    unavailableIds,
    unknownIds,
    errors,
    meta: {
      requestedCount: requestedIds.length,
      resultCount: posts.length,
      batchesFetched,
    },
  };
}
