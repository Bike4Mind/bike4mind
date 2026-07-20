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

import { semanticDataLakeSearch, type SemanticDataLakeSearchParams } from './semanticDataLakeSearch';

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
});
