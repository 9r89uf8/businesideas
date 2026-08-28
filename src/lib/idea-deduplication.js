import { PIPELINE } from "./config.js";
import { normalizeFingerprint } from "./fingerprints.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
  "is", "it", "of", "on", "or", "that", "the", "their", "to", "with",
]);

function significantTokens(value) {
  return normalizeFingerprint(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && token !== "|" && !STOP_WORDS.has(token));
}

export function substantiallySame(left, right) {
  const normalizedLeft = normalizeFingerprint(left);
  const normalizedRight = normalizeFingerprint(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  ) return true;

  const leftTokens = new Set(significantTokens(normalizedLeft));
  const rightTokens = new Set(significantTokens(normalizedRight));
  if (!leftTokens.size || !rightTokens.size) return false;
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return overlap >= 2 && overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.6;
}

export function cosineSimilarity(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length === 0 ||
    left.length !== right.length
  ) {
    return -1;
  }

  let dotProduct = 0;
  let leftMagnitudeSquared = 0;
  let rightMagnitudeSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return -1;
    dotProduct += leftValue * rightValue;
    leftMagnitudeSquared += leftValue * leftValue;
    rightMagnitudeSquared += rightValue * rightValue;
  }

  if (leftMagnitudeSquared === 0 || rightMagnitudeSquared === 0) return -1;
  return dotProduct / Math.sqrt(leftMagnitudeSquared * rightMagnitudeSquared);
}

export function isSemanticIdeaDuplicate(
  candidate,
  match,
  similarity,
  threshold = PIPELINE.semanticDuplicateThreshold,
) {
  return (
    Number.isFinite(similarity) &&
    similarity >= threshold &&
    substantiallySame(candidate?.target_customer, match?.target_customer) &&
    substantiallySame(candidate?.problem, match?.problem)
  );
}

export function duplicatesAcceptedIdea(
  candidate,
  embedding,
  accepted,
  threshold = PIPELINE.semanticDuplicateThreshold,
) {
  return (Array.isArray(accepted) ? accepted : []).some((match) =>
    candidate?.fingerprint_hash === match?.fingerprint_hash ||
    isSemanticIdeaDuplicate(
      candidate,
      match,
      cosineSimilarity(embedding, match?.embedding),
      threshold,
    ),
  );
}
