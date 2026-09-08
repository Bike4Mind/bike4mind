import type { CitableFabFileFields, IFabFileRepository } from '@bike4mind/common';
import { isRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';

/**
 * The FabFile fields the citability predicate reads - a projection, so callers fetch only these.
 *
 * Aliases the repository-side type so the read and the predicate cannot drift apart: the resolvers
 * below call `findCitableFieldsByIds`, which projects exactly this set.
 */
export type CitableFileFields = CitableFabFileFields;

/**
 * Is this source document still retrievable for citation by the knowledge tool RIGHT NOW?
 *
 * MUST STAY IN SYNC with the corpus defer gate in ChatCompletionProcess.resolveCorpusInlinePlan
 * (b4m-core/services) - this is the same "can the knowledge tool actually reach this doc" predicate,
 * duplicated across packages with no shared symbol. Change one, change the other.
 *
 * The SAME reachability that gate enforces (+ #1464): a lake belief must only lean on a doc that
 * `search_knowledge_base`'s semantic arm can actually surface, or its citation dangles. Conditions:
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
 * Which of these source documents still EXIST at all?
 *
 * Deliberately NOT `isFabFileCitable`, and the difference is the whole point. Citability answers
 * "can the semantic arm surface this doc right now", so it also rejects a live doc that is merely
 * un-vectorized or sitting in a different embedding space. That is correct for recall and wrong for
 * any surface reporting what a lake KNOWS: it would hide beliefs whose documents are alive and fine,
 * making the report understate the profile.
 *
 * This predicate is existence only, which is what a retention question needs - a belief whose every
 * source has been permanently destroyed is an orphan no future purge can find, because purges are
 * keyed by source id. Beliefs with no sources at all are NOT orphans (nothing was destroyed), so
 * callers must not use an empty source list as evidence of anything.
 */
export function createSurvivingSourcesResolver(deps: {
  fabfiles: Pick<IFabFileRepository, 'findExistingIdsByIds'>;
}): (sourceIds: string[]) => Promise<Set<string>> {
  return async sourceIds => {
    if (sourceIds.length === 0) return new Set();
    // Existence only, so nothing is hydrated. A lake profile can cite one source per belief with no
    // cap, so this set converges on every document in the lake - and the unprojected read it replaces
    // built a full mongoose document for each of them on every profile render.
    return new Set(await deps.fabfiles.findExistingIdsByIds(sourceIds));
  };
}

/**
 * Build the reachability resolver `recallLakeMemory` injects: given a belief set's source FabFile ids,
 * return the subset the knowledge tool can currently cite. Batches one `findAllByIds` read and applies
 * `isFabFileCitable` per file. Fail-safe is the CALLER's job (recallLakeMemory drops uncited beliefs);
 * this returns exactly the reachable set.
 */
export function createReachableSourcesResolver(deps: {
  fabfiles: Pick<IFabFileRepository, 'findCitableFieldsByIds'>;
  queryEmbeddingModel?: string;
  retrievalFilter?: RetrievalExclusionOptions;
}): (sourceIds: string[]) => Promise<Set<string>> {
  return async sourceIds => {
    if (sourceIds.length === 0) return new Set();
    // Projected: this runs on the recall path, once per chat turn that touches a lake.
    const files = await deps.fabfiles.findCitableFieldsByIds(sourceIds);
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
