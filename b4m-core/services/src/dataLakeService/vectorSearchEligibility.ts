/**
 * Per-file eligibility for the Atlas/OpenSearch ANN cutover: which files in an already
 * single-model file set can be served by the ANN index right now, versus which must still go
 * through the brute-force scan. Deliberately per-file, not all-or-nothing - a file vectorized
 * moments ago (mongot indexing lag) or mid-backfill must not block every OTHER already-stamped
 * file in the same lake from using the index. Used for both the query's own model and, since the
 * mixed-embeddingModel ANN cutover, each alternate model's own file bucket (see alternateModelAnn.ts) -
 * this module stays model-agnostic either way.
 */

/** mongot indexes a write via change streams asynchronously; a fresher stamp is not trusted to be queryable yet. */
export const VECTOR_SEARCH_READY_LAG_MS = 60_000;

export interface VectorSearchReadinessFile {
  id: string;
  /** Set once stampChunkEmbeddingModel finishes for this file - see FabFile.chunkEmbeddingModelStampedAt. */
  chunkEmbeddingModelStampedAt?: Date | string | null;
}

export function isVectorSearchReady(file: VectorSearchReadinessFile, now: Date): boolean {
  if (!file.chunkEmbeddingModelStampedAt) return false;
  const stampedAt = new Date(file.chunkEmbeddingModelStampedAt).getTime();
  if (!Number.isFinite(stampedAt)) return false;
  return now.getTime() - stampedAt >= VECTOR_SEARCH_READY_LAG_MS;
}

/** Splits an already same-model file set into ANN-ready and scan-only, preserving input order in each. */
export function partitionByVectorSearchReadiness<T extends VectorSearchReadinessFile>(
  files: T[],
  now: Date
): { annReady: T[]; scanOnly: T[] } {
  const annReady: T[] = [];
  const scanOnly: T[] = [];
  for (const file of files) {
    (isVectorSearchReady(file, now) ? annReady : scanOnly).push(file);
  }
  return { annReady, scanOnly };
}
