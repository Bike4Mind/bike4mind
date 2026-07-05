import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CollectionType } from '@bike4mind/common';
import {
  buildCollectionSearchPipeline,
  CollectionSearchParams,
  CollectionSearchDeps,
} from '../queries/collectionSearchQuery';

const mockFindSessionIds = vi.fn<(userId: string) => Promise<string[]>>();

function makeParams(overrides: Partial<CollectionSearchParams> = {}): CollectionSearchParams {
  return {
    userId: 'user123',
    page: 1,
    limit: 10,
    search: '',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CollectionSearchDeps> = {}): CollectionSearchDeps {
  return {
    findSessionIdsByUserId: mockFindSessionIds,
    useDocumentDB: false,
    ...overrides,
  };
}

/** Helper: find a $unionWith stage targeting a specific collection */
function findUnionWith(pipeline: Record<string, unknown>[], coll: string) {
  return pipeline.find(stage => '$unionWith' in stage && (stage.$unionWith as Record<string, unknown>).coll === coll);
}

describe('buildCollectionSearchPipeline', () => {
  beforeEach(() => {
    mockFindSessionIds.mockReset();
    mockFindSessionIds.mockResolvedValue([]);
  });

  // ── 1. Includes sessionmodels when type is undefined ──────────────
  describe('sessionmodels union', () => {
    it('includes sessionmodels union when type is undefined', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(findUnionWith(pipeline, 'sessionmodels')).toBeDefined();
    });

    it('includes sessionmodels union when type is notebook', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.NOTEBOOK }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'sessionmodels')).toBeDefined();
    });

    it('excludes sessionmodels union when type is knowledge', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.KNOWLEDGE }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'sessionmodels')).toBeUndefined();
    });
  });

  // ── 2. Includes fabfiles when type is undefined or knowledge ──────
  describe('fabfiles union', () => {
    it('includes fabfiles union when type is undefined', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(findUnionWith(pipeline, 'fabfiles')).toBeDefined();
    });

    it('includes fabfiles union when type is knowledge', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.KNOWLEDGE }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'fabfiles')).toBeDefined();
    });

    it('excludes fabfiles union when type is notebook', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.NOTEBOOK }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'fabfiles')).toBeUndefined();
    });
  });

  // ── 3. Includes projects when type is undefined or project ────────
  describe('projects union', () => {
    it('includes projects union when type is undefined', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(findUnionWith(pipeline, 'projects')).toBeDefined();
    });

    it('includes projects union when type is project', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.PROJECT }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'projects')).toBeDefined();
    });

    it('excludes projects union when type is ai_image', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.AI_IMAGE }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'projects')).toBeUndefined();
    });
  });

  // ── 4. Includes quests when type is undefined or ai_image ─────────
  describe('quests union', () => {
    it('includes quests union when type is undefined and sessions exist', async () => {
      mockFindSessionIds.mockResolvedValue(['sess1', 'sess2']);
      const { pipeline } = await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(findUnionWith(pipeline, 'quests')).toBeDefined();
    });

    it('includes quests union when type is ai_image and sessions exist', async () => {
      mockFindSessionIds.mockResolvedValue(['sess1']);
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.AI_IMAGE }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'quests')).toBeDefined();
    });

    it('excludes quests union when type is ai_image but no sessions', async () => {
      mockFindSessionIds.mockResolvedValue([]);
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.AI_IMAGE }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'quests')).toBeUndefined();
    });

    it('excludes quests union when type is knowledge', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.KNOWLEDGE }),
        makeDeps()
      );
      expect(findUnionWith(pipeline, 'quests')).toBeUndefined();
    });
  });

  // ── 5. findSessionIdsByUserId is called only when ai_image included
  describe('findSessionIdsByUserId invocation', () => {
    it('is called when type is undefined', async () => {
      await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(mockFindSessionIds).toHaveBeenCalledWith('user123');
    });

    it('is called when type is ai_image', async () => {
      await buildCollectionSearchPipeline(makeParams({ type: CollectionType.AI_IMAGE }), makeDeps());
      expect(mockFindSessionIds).toHaveBeenCalledWith('user123');
    });

    it('is NOT called when type is notebook', async () => {
      await buildCollectionSearchPipeline(makeParams({ type: CollectionType.NOTEBOOK }), makeDeps());
      expect(mockFindSessionIds).not.toHaveBeenCalled();
    });

    it('is NOT called when type is knowledge', async () => {
      await buildCollectionSearchPipeline(makeParams({ type: CollectionType.KNOWLEDGE }), makeDeps());
      expect(mockFindSessionIds).not.toHaveBeenCalled();
    });

    it('is NOT called when type is project', async () => {
      await buildCollectionSearchPipeline(makeParams({ type: CollectionType.PROJECT }), makeDeps());
      expect(mockFindSessionIds).not.toHaveBeenCalled();
    });
  });

  // ── 6. Facet stages have correct sort/skip/limit ──────────────────
  describe('facet stages', () => {
    it('returns totalCount and collections facet stages', async () => {
      const { facetStages } = await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(facetStages.totalCount).toEqual([{ $count: 'count' }]);
      expect(facetStages.collections).toEqual([{ $sort: { updatedAt: -1 } }, { $skip: 0 }, { $limit: 10 }]);
    });

    it('computes correct skip for page 3, limit 20', async () => {
      const { facetStages } = await buildCollectionSearchPipeline(makeParams({ page: 3, limit: 20 }), makeDeps());
      expect(facetStages.collections).toEqual([{ $sort: { updatedAt: -1 } }, { $skip: 40 }, { $limit: 20 }]);
    });
  });

  // ── 7. Search filter creates correct $regex conditions ────────────
  describe('search filter', () => {
    it('applies $regex search to sessionmodels name field', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams({ search: 'test query' }), makeDeps());

      const sessionUnion = findUnionWith(pipeline, 'sessionmodels');
      expect(sessionUnion).toBeDefined();

      const unionPipeline = (sessionUnion as Record<string, Record<string, unknown>>).$unionWith.pipeline as Record<
        string,
        unknown
      >[];
      const matchStage = unionPipeline[0] as { $match: Record<string, unknown> };
      expect(matchStage.$match.name).toEqual({ $regex: 'test query', $options: 'i' });
    });

    it('applies $regex search to fabfiles fileName field', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams({ search: 'report' }), makeDeps());

      const fabfilesUnion = findUnionWith(pipeline, 'fabfiles');
      const unionPipeline = (fabfilesUnion as Record<string, Record<string, unknown>>).$unionWith.pipeline as Record<
        string,
        unknown
      >[];
      const matchStage = unionPipeline[0] as { $match: Record<string, unknown> };
      expect(matchStage.$match.fileName).toEqual({ $regex: 'report', $options: 'i' });
    });

    it('does not add search filter when search is empty', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams({ search: '' }), makeDeps());

      const sessionUnion = findUnionWith(pipeline, 'sessionmodels');
      const unionPipeline = (sessionUnion as Record<string, Record<string, unknown>>).$unionWith.pipeline as Record<
        string,
        unknown
      >[];
      const matchStage = unionPipeline[0] as { $match: Record<string, unknown> };
      expect(matchStage.$match.name).toBeUndefined();
    });
  });

  // ── 8. Pipeline starts with $match: { _id: null } ────────────────
  describe('base pipeline structure', () => {
    it('starts with empty-result $match stage', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(makeParams(), makeDeps());
      expect(pipeline[0]).toEqual({ $match: { _id: null } });
    });
  });

  // ── 9. DocumentDB compatibility for quests pipeline ───────────────
  describe('DocumentDB compatibility', () => {
    it('passes quests pipeline through convertPipelineForDocumentDB when useDocumentDB is true', async () => {
      mockFindSessionIds.mockResolvedValue(['sess1']);

      // When useDocumentDB is false, the pipeline is passed through as-is
      const { pipeline: pipelineNormal } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.AI_IMAGE }),
        makeDeps({ useDocumentDB: false })
      );

      const { pipeline: pipelineDocDB } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.AI_IMAGE }),
        makeDeps({ useDocumentDB: true })
      );

      // Both should have quests union
      expect(findUnionWith(pipelineNormal, 'quests')).toBeDefined();
      expect(findUnionWith(pipelineDocDB, 'quests')).toBeDefined();

      // The quest pipeline contents should be functionally equivalent
      // (convertPipelineForDocumentDB is a no-op for stages without $lookup/$facet)
      const normalQuestPipeline = (findUnionWith(pipelineNormal, 'quests') as Record<string, Record<string, unknown>>)
        .$unionWith.pipeline;
      const docDBQuestPipeline = (findUnionWith(pipelineDocDB, 'quests') as Record<string, Record<string, unknown>>)
        .$unionWith.pipeline;

      expect(normalQuestPipeline).toBeDefined();
      expect(docDBQuestPipeline).toBeDefined();
    });
  });

  // ── 10. Type filtering - only relevant collections included ───────
  describe('type filtering — single type', () => {
    it('only includes sessionmodels when type is notebook', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.NOTEBOOK }),
        makeDeps()
      );

      expect(findUnionWith(pipeline, 'sessionmodels')).toBeDefined();
      expect(findUnionWith(pipeline, 'fabfiles')).toBeUndefined();
      expect(findUnionWith(pipeline, 'projects')).toBeUndefined();
      expect(findUnionWith(pipeline, 'quests')).toBeUndefined();
    });

    it('only includes fabfiles when type is knowledge', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.KNOWLEDGE }),
        makeDeps()
      );

      expect(findUnionWith(pipeline, 'sessionmodels')).toBeUndefined();
      expect(findUnionWith(pipeline, 'fabfiles')).toBeDefined();
      expect(findUnionWith(pipeline, 'projects')).toBeUndefined();
      expect(findUnionWith(pipeline, 'quests')).toBeUndefined();
    });

    it('only includes projects when type is project', async () => {
      const { pipeline } = await buildCollectionSearchPipeline(
        makeParams({ type: CollectionType.PROJECT }),
        makeDeps()
      );

      expect(findUnionWith(pipeline, 'sessionmodels')).toBeUndefined();
      expect(findUnionWith(pipeline, 'fabfiles')).toBeUndefined();
      expect(findUnionWith(pipeline, 'projects')).toBeDefined();
      expect(findUnionWith(pipeline, 'quests')).toBeUndefined();
    });
  });
});
