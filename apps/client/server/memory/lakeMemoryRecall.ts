import { adminSettingsRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import type { RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import { recallLakeMemory, type AccessibleLake, type LakeBeliefRecall } from './recallLakeMemory';
import { createReachableSourcesResolver } from './lakeSourceReachability';

/**
 * App-layer wiring for the `recallLakeMemory` the chat service injects (#1440). Adapts the core
 * feature's high-level call - the user's entitled `datalake:` tags plus the session retrieval filter -
 * into the principal-generic core read:
 *  1. resolve each tag to its lake's DEK owner (`createdByUserId`);
 *  2. build the FabFile-backed source-reachability resolver, scoped to the FAB chunk vector space
 *     (`defaultEmbeddingModel`) and the session's retrieval filter;
 *  3. delegate to `recallLakeMemory`.
 *
 * The query vector space for reachability is the FAB chunk space, NOT the memento space the beliefs
 * are recalled in: reachability asks whether `search_knowledge_base` can surface the SOURCE DOC, whose
 * vectors live in the FabFile chunk index.
 */
export async function recallLakeMemoryForSession(input: {
  userId: string;
  query: string;
  dataLakeTags: string[];
  retrievalFilter?: RetrievalExclusionOptions;
}): Promise<LakeBeliefRecall[]> {
  if (input.dataLakeTags.length === 0 || !input.query.trim()) return [];

  const lakes = (
    await Promise.all(
      input.dataLakeTags.map(async (datalakeTag): Promise<AccessibleLake | null> => {
        // `findByDatalakeTag` is a bare tag lookup with no status/deletedAt filter, whereas the
        // authorizing access query only admits `status: 'active'` lakes. Re-apply that gate here so a
        // lake archived or soft-deleted MID-SESSION stops decrypting memory the moment it leaves the
        // active set - otherwise the read would outlive the authorization that granted it.
        // `status` is the lake's lifecycle state: only 'active' is authorized to read (draft, archived,
        // deleting, and deleted all fall out here), matching the authorizing access query.
        const lake = await dataLakeRepository.findByDatalakeTag(datalakeTag);
        if (!lake?.createdByUserId || lake.status !== 'active') return null;
        return { datalakeTag, ownerUserId: lake.createdByUserId };
      })
    )
  ).filter((lake): lake is AccessibleLake => lake !== null);
  if (lakes.length === 0) return [];

  const queryEmbeddingModel = await adminSettingsRepository
    .getSettingsValue('defaultEmbeddingModel')
    .catch(() => undefined);

  const resolveReachableSources = createReachableSourcesResolver({
    fabfiles: fabFileRepository,
    queryEmbeddingModel: typeof queryEmbeddingModel === 'string' ? queryEmbeddingModel : undefined,
    retrievalFilter: input.retrievalFilter,
  });

  return recallLakeMemory({ userId: input.userId, query: input.query, lakes, resolveReachableSources });
}
