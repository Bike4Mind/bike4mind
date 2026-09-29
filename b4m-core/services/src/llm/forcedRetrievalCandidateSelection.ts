import { isVectorSearchReady, type VectorSearchReadinessFile } from '../dataLakeService/vectorSearchEligibility';

/**
 * How forced retrieval chose the files whose chunks it scores this turn:
 * - `all`: the scope fit under the candidate cap, so nothing was chosen away.
 * - `relevance`: an ANN query over the scope's chunks ranked the files (see rankCandidateFilesByRelevance).
 * - `fileName`: the cap cut the scope by file name - vector search off, the index not queryable, or
 *   the ANN query failed or ran past its deadline. The same tail is lost on every turn.
 */
export type ForcedRetrievalCandidateSelection = 'all' | 'relevance' | 'fileName';

type AnnChunkHit = { fabFileId: string; score: number };

/**
 * Orders `files` for the per-turn candidate cap from an ANN query's chunk hits, in three tiers:
 * 1. files with a hit, by their best chunk score (id breaks ties so the order is reproducible);
 * 2. files the index cannot answer for yet (not stamped, or within the mongot lag), in input order;
 * 3. index-ready files the ANN ranked outside its pool, in input order.
 * Tier 2 outranks tier 3 because the index has already judged tier 3 and has no opinion on tier 2.
 * Hits naming a file outside `files` are ignored. `files` is expected in the stable scan order.
 */
export function rankCandidateFilesByRelevance<T extends VectorSearchReadinessFile>(
  files: T[],
  hits: AnnChunkHit[],
  now: Date
): T[] {
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
  return [...withHit, ...notIndexed, ...rankedOutside];
}

/** Rejects with a timeout error once `ms` elapses, and never leaves the timer running after `promise` settles. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
