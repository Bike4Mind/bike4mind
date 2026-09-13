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

/**
 * Second gate for a retrieval store that lives OUTSIDE Mongo (self-host OpenSearch): of the files
 * the readiness stamp already cleared, which are confirmed to be IN that store right now.
 *
 * The stamp cannot answer this - it is written on the Mongo side and knows nothing about the
 * separate cluster, whose dual-write is fail-open and has no backfill for files predating it. A
 * file can therefore be permanently stamped-ready and permanently absent from the index. Splitting
 * it off here (rather than excluding it) keeps it on the brute-force scan, where it is still
 * findable. Atlas needs no equivalent: mongot indexes the chunk collection itself.
 */
export function partitionByIndexResidency<T extends { id: string }>(
  files: T[],
  residentFileIds: ReadonlySet<string>
): { resident: T[]; absent: T[] } {
  const resident: T[] = [];
  const absent: T[] = [];
  for (const file of files) {
    (residentFileIds.has(file.id) ? resident : absent).push(file);
  }
  return { resident, absent };
}
