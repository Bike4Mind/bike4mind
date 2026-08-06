import type { IFabFileDocument, IFabFileRepository } from '@bike4mind/common';
import { isRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';

/** The FabFile fields the citability predicate reads - a projection, so callers can fetch only these. */
export type CitableFileFields = Pick<
  IFabFileDocument,
  | 'id'
  | 'deletedAt'
  | 'archivedAt'
  | 'chunkCount'
  | 'vectorizedChunkCount'
  | 'embeddingModel'
  | 'fileName'
  | 'vectorized'
>;

/**
 * Is this source document still retrievable for citation by the knowledge tool RIGHT NOW?
 *
 * The SAME reachability the corpus defer gate enforces (ChatCompletionProcess.resolveCorpusInlinePlan
 * + #1464): a lake belief must only lean on a doc that `search_knowledge_base`'s semantic arm can
 * actually surface, or its citation dangles. Conditions:
 *  - live: not soft-deleted or archived, and not retrieval-excluded by the session filter;
 *  - fully vectorized: `vectorizedChunkCount >= chunkCount` (> 0) - a partially/never-vectorized doc
 *    is not reliably in the vector index;
 *  - same vector space: `embeddingModel === queryEmbeddingModel`, exact match. Deliberately STRICTER
 *    than embeddingMismatch's `isForeignEmbeddingModel` (which counts an UNLABELED doc as comparable):
 *    an unlabeled doc stays uncitable here rather than risk a dangling citation. Those two answer
 *    different questions - what search SCORES vs. what is SAFE to rely on - which is exactly why the
 *    defer gate's note warns against consolidating them.
 *
 * An empty/undefined `queryEmbeddingModel` means the semantic arm cannot run, so nothing is citable.
 */
export function isFabFileCitable(
  file: CitableFileFields,
  opts: { queryEmbeddingModel?: string; retrievalFilter?: RetrievalExclusionOptions }
): boolean {
  if (file.deletedAt || file.archivedAt) return false;
  if (isRetrievalExcluded(file, opts.retrievalFilter ?? {})) return false;
  const chunks = file.chunkCount ?? 0;
  if (!(chunks > 0 && (file.vectorizedChunkCount ?? 0) >= chunks)) return false;
  return Boolean(opts.queryEmbeddingModel) && file.embeddingModel === opts.queryEmbeddingModel;
}

/**
 * Build the reachability resolver `recallLakeMemory` injects: given a belief set's source FabFile ids,
 * return the subset the knowledge tool can currently cite. Batches one `findAllByIds` read and applies
 * `isFabFileCitable` per file. Fail-safe is the CALLER's job (recallLakeMemory drops uncited beliefs);
 * this returns exactly the reachable set.
 */
export function createReachableSourcesResolver(deps: {
  fabfiles: Pick<IFabFileRepository, 'findAllByIds'>;
  queryEmbeddingModel?: string;
  retrievalFilter?: RetrievalExclusionOptions;
}): (sourceIds: string[]) => Promise<Set<string>> {
  return async sourceIds => {
    if (sourceIds.length === 0) return new Set();
    const files = await deps.fabfiles.findAllByIds(sourceIds);
    const reachable = new Set<string>();
    for (const file of files) {
      if (
        isFabFileCitable(file, { queryEmbeddingModel: deps.queryEmbeddingModel, retrievalFilter: deps.retrievalFilter })
      ) {
        reachable.add(file.id);
      }
    }
    return reachable;
  };
}
