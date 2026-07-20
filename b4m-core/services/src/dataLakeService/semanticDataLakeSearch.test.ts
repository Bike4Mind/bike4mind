import { describe, it, expect, vi } from 'vitest';

// Mock only the embedding/provider helpers from the utils barrel; keep the real
// `@bike4mind/utils/retrievalExclusion` subpath so filterRetrievalExcluded runs for real.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getProviderFromModel: () => 'openai',
    computeCosineSimilarity: () => 0.9,
    EmbeddingFactory: class {
      createEmbeddingService() {
        return { generateEmbedding: async () => [1, 0] };
      }
    },
  };
});

import {
  fileScopedSemanticSearch,
  semanticDataLakeSearch,
  type SemanticDataLakeSearchParams,
} from './semanticDataLakeSearch';

const baseParams = (): SemanticDataLakeSearchParams => ({
  userId: 'u1',
  query: 'stage III treatment',
  embeddingModel: 'text-embedding-ada-002' as SemanticDataLakeSearchParams['embeddingModel'],
  apiKeyTable: { openai: 'k' },
  dataLakeTags: ['datalake:x'],
  dataLakeTagPrefixes: [],
});

const makeAdapters = (findVectors: ReturnType<typeof vi.fn>) => ({
  db: {
    fabfiles: {
      search: vi.fn().mockResolvedValue({
        data: [
          { id: 'm', fileName: 'MARK - retired.pdf', tags: [], vectorized: true },
          { id: 'c', fileName: 'Clean.pdf', tags: [], vectorized: true },
        ],
      }),
    },
    fabfilechunks: { findVectorsByFabFileIds: findVectors },
  },
});

describe('semanticDataLakeSearch retrieval exclusion', () => {
  it('drops an excluded file BEFORE loading its chunk vectors', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    await semanticDataLakeSearch(
      { ...baseParams(), retrievalFilter: { excludeFilenameMarkers: ['MARK'] } },
      makeAdapters(findVectors) as never
    );
    // The vector lookup must be scoped to the clean file only - the marked file never
    // reaches the (expensive) vector load.
    expect(findVectors).toHaveBeenCalledTimes(1);
    expect(findVectors.mock.calls[0][0]).toEqual(['c']);
  });

  it('no filter (default): both files are scoped for vector lookup', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    await semanticDataLakeSearch(baseParams(), makeAdapters(findVectors) as never);
    expect(findVectors.mock.calls[0][0]).toEqual(['m', 'c']);
  });

  it('tag path unchanged after core extraction: no data-lake tags returns empty without touching the DB', async () => {
    const findVectors = vi.fn().mockResolvedValue([]);
    const adapters = makeAdapters(findVectors);
    const result = await semanticDataLakeSearch({ ...baseParams(), dataLakeTags: [] }, adapters as never);
    expect(result.results).toEqual([]);
    expect(adapters.db.fabfiles.search).not.toHaveBeenCalled();
    expect(findVectors).not.toHaveBeenCalled();
  });
});

describe('fileScopedSemanticSearch (allow-list scope)', () => {
  const scopedParams = (fileIds: string[]) => ({
    query: 'stage III treatment',
    fileIds,
    embeddingModel: 'text-embedding-ada-002' as SemanticDataLakeSearchParams['embeddingModel'],
    apiKeyTable: { openai: 'k' },
  });

  const scopedAdapters = (opts: {
    files?: { id: string; fileName: string; tags?: { name: string }[] }[];
    chunks?: { id: string; fabFileId: string; vector: number[]; text: string }[];
  }) => {
    const getAccessibleFiles = vi.fn().mockResolvedValue(opts.files ?? []);
    const findVectorsByFabFileIds = vi.fn().mockResolvedValue(opts.chunks ?? []);
    return {
      adapters: { db: { fabfiles: { getAccessibleFiles }, fabfilechunks: { findVectorsByFabFileIds } } },
      getAccessibleFiles,
      findVectorsByFabFileIds,
    };
  };

  it('searches vectors for EXACTLY the scoped file ids and returns only their hits', async () => {
    const { adapters, getAccessibleFiles, findVectorsByFabFileIds } = scopedAdapters({
      files: [{ id: 'in-scope', fileName: 'InScope.pdf', tags: [] }],
      chunks: [{ id: 'ch1', fabFileId: 'in-scope', vector: [1, 0], text: 'scoped content' }],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['in-scope']), adapters as never);

    expect(getAccessibleFiles).toHaveBeenCalledWith(['in-scope'], { deletedAt: null, archivedAt: null });
    expect(findVectorsByFabFileIds.mock.calls[0][0]).toEqual(['in-scope']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].fileId).toBe('in-scope');
  });

  it('empty scope returns empty WITHOUT any DB access (scoped-to-nothing contract)', async () => {
    const { adapters, getAccessibleFiles, findVectorsByFabFileIds } = scopedAdapters({});

    const result = await fileScopedSemanticSearch(scopedParams([]), adapters as never);

    expect(result.results).toEqual([]);
    expect(getAccessibleFiles).not.toHaveBeenCalled();
    expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
  });

  it('deleted/archived files in scope contribute nothing (metadata fetch filters them)', async () => {
    // getAccessibleFiles applies { deletedAt: null, archivedAt: null }, so a scope whose
    // only file is deleted resolves to no live files and no vectors are loaded.
    const { adapters, findVectorsByFabFileIds } = scopedAdapters({ files: [] });

    const result = await fileScopedSemanticSearch(scopedParams(['deleted-file']), adapters as never);

    expect(result.results).toEqual([]);
    expect(findVectorsByFabFileIds).not.toHaveBeenCalled();
  });

  it('files with no vector chunks yield an empty result, not an error', async () => {
    const { adapters } = scopedAdapters({
      files: [{ id: 'in-scope', fileName: 'NoVectors.pdf', tags: [] }],
      chunks: [],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['in-scope']), adapters as never);

    expect(result.results).toEqual([]);
    expect(result.filesInScope).toBe(1);
  });

  it('a chunk whose file dropped out of the live set is skipped', async () => {
    const { adapters } = scopedAdapters({
      files: [{ id: 'live', fileName: 'Live.pdf', tags: [] }],
      chunks: [
        { id: 'ch1', fabFileId: 'live', vector: [1, 0], text: 'live content' },
        { id: 'ch2', fabFileId: 'gone', vector: [1, 0], text: 'orphan content' },
      ],
    });

    const result = await fileScopedSemanticSearch(scopedParams(['live', 'gone']), adapters as never);

    expect(result.results.map(r => r.fileId)).toEqual(['live']);
  });
});
