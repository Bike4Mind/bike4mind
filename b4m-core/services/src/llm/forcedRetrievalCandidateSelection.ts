import {
  isVectorSearchReady,
  VECTOR_SEARCH_READY_LAG_MS,
  type VectorSearchReadinessFile,
} from '../dataLakeService/vectorSearchEligibility';

/**
 * How forced retrieval chose the files whose chunks it scores this turn:
 * - `all`: the scope fit under the candidate cap, so nothing was chosen away.
 * - `relevance`: an ANN query over the scope's chunks ranked the files (see rankCandidateFilesByRelevance).
 * - `fileName`: the cap cut the scope by file name - vector search off, the index not queryable, or
 *   the ANN query failed or ran past its deadline. The same tail is lost on every turn.
 */
export type ForcedRetrievalCandidateSelection = 'all' | 'relevance' | 'fileName';

/**
 * Why a `fileName` cut happened. Metric dimension value (forcedRetrievalSelectionMetrics.ts), so
 * keep these stable. `relevance-unavailable` covers vector search off, unreadable, or not Atlas.
 */
export type ForcedRetrievalFallbackReason =
  'relevance-unavailable' | 'no-ready-file' | 'not-queryable' | 'no-hits' | 'deadline' | 'error';

type AnnChunkHit = { fabFileId: string; score: number };

/**
 * Orders `files` for the per-turn candidate cap from an ANN query's chunk hits, in three tiers:
 * 1. files with a hit, by their best chunk score (id breaks ties so the order is reproducible);
 * 2. files the index cannot answer for yet (not stamped, or within the mongot lag), in input order;
 * 3. index-ready files the ANN ranked outside its pool, in input order.
 * Tier 2 outranks tier 3 because the index has already judged tier 3 and has no opinion on tier 2.
 * Hits naming a file outside `files` are ignored. `files` is expected in the stable scan order.
 * This is the uncut order; selectRelevanceCandidates applies the cap and the tier-2 reserve.
 */
export function rankCandidateFilesByRelevance<T extends VectorSearchReadinessFile>(
  files: T[],
  hits: AnnChunkHit[],
  now: Date
): T[] {
  const { withHit, notIndexed, rankedOutside } = splitByRelevanceTier(files, hits, now);
  return [...withHit, ...notIndexed, ...rankedOutside];
}

/**
 * rankCandidateFilesByRelevance cut at `cap`, except that up to `notIndexedReserve` files stamped within
 * the mongot lag take the first slots, displacing the lowest-scoring hits. Such a file has no hit yet,
 * so without the reserve it would sit behind a full cap of hits and be dropped silently. They go first
 * rather than last because the chunk scan spends its budget in this order (ChatCompletionFeatures.ts),
 * so a reserved slot at the tail could be kept yet never read. Never-stamped files
 * (chunkless images, legacy rows) never get a slot: waiting does not make them searchable, so they
 * keep their tier-2 position behind the hits and are cut silently, as before.
 * `notIndexedCut` counts only the lag-window files that still fell past the cap, for the coverage notice.
 */
export function selectRelevanceCandidates<T extends VectorSearchReadinessFile>(
  files: T[],
  hits: AnnChunkHit[],
  now: Date,
  { cap, notIndexedReserve }: { cap: number; notIndexedReserve: number }
): { files: T[]; notIndexedCut: number } {
  const { withHit, notIndexed, rankedOutside } = splitByRelevanceTier(files, hits, now);
  const recent = notIndexed.filter(file => isStampedWithinLag(file, now));
  const unstamped = notIndexed.filter(file => !isStampedWithinLag(file, now));
  const reserved = Math.min(recent.length, notIndexedReserve);
  const hitSlots = Math.max(0, cap - reserved);
  const ordered = [
    ...recent.slice(0, reserved),
    ...withHit.slice(0, hitSlots),
    ...recent.slice(reserved),
    ...withHit.slice(hitSlots),
    ...unstamped,
    ...rankedOutside,
  ];
  const recentKept = Math.min(recent.length, Math.max(0, cap - Math.min(withHit.length, hitSlots)));
  return { files: ordered.slice(0, cap), notIndexedCut: recent.length - recentKept };
}

/** Stamped, but not yet old enough for mongot to be trusted to have indexed it. */
function isStampedWithinLag(file: VectorSearchReadinessFile, now: Date): boolean {
  if (!file.chunkEmbeddingModelStampedAt) return false;
  const stampedAt = new Date(file.chunkEmbeddingModelStampedAt).getTime();
  return Number.isFinite(stampedAt) && now.getTime() - stampedAt < VECTOR_SEARCH_READY_LAG_MS;
}

function splitByRelevanceTier<T extends VectorSearchReadinessFile>(files: T[], hits: AnnChunkHit[], now: Date) {
  const bestScoreByFileId = new Map<string, number>();
  for (const hit of hits) {
    if (!Number.isFinite(hit.score)) continue;
    const best = bestScoreByFileId.get(hit.fabFileId);
    if (best === undefined || hit.score > best) bestScoreByFileId.set(hit.fabFileId, hit.score);
  }

  const withHit: T[] = [];
  const notIndexed: T[] = [];
  const rankedOutside: T[] = [];
  for (const file of files) {
    if (bestScoreByFileId.has(file.id)) withHit.push(file);
    else if (!isVectorSearchReady(file, now)) notIndexed.push(file);
    else rankedOutside.push(file);
  }
  withHit.sort((a, b) => {
    const byScore = (bestScoreByFileId.get(b.id) ?? 0) - (bestScoreByFileId.get(a.id) ?? 0);
    if (byScore !== 0) return byScore;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { withHit, notIndexed, rankedOutside };
}

export class DeadlineExceededError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} exceeded ${ms}ms`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Rejects with a DeadlineExceededError once `ms` elapses, and never leaves the timer running after
 * `promise` settles. It bounds the caller's wait only; the underlying work is not cancelled.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
