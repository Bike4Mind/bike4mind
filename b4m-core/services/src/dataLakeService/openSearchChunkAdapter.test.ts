import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  loadSearchIndexClient: vi.fn(),
  selfHostVectorIndexName: vi.fn(),
}));

vi.mock('@bike4mind/fab-pipeline', () => ({
  FabFileChunkSearchIndex: { loadSearchIndexClient: h.loadSearchIndexClient },
  selfHostVectorIndexName: h.selfHostVectorIndexName,
}));

import { openSearchChunkAdapter, knownExistingIndexes } from './openSearchChunkAdapter';

describe('openSearchChunkAdapter.knnSearch', () => {
  const mockClient = { indexExists: vi.fn(), knnQuery: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    knownExistingIndexes.clear();
    h.loadSearchIndexClient.mockResolvedValue(mockClient);
  });

  it('fails closed (returns []) when the model has no registered index name', async () => {
    h.selfHostVectorIndexName.mockReturnValue(null);

    const result = await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'not-a-real-model');

    expect(result).toEqual([]);
    expect(mockClient.knnQuery).not.toHaveBeenCalled();
  });

  it('fails closed (returns []) when the index does not exist yet', async () => {
    h.selfHostVectorIndexName.mockReturnValue('idx-name');
    mockClient.indexExists.mockResolvedValue(false);

    const result = await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'text-embedding-3-small');

    expect(result).toEqual([]);
    expect(mockClient.knnQuery).not.toHaveBeenCalled();
  });

  it('queries with a fabFileId+embeddingModel filter, size bounded to the limit, and vector excluded from the response', async () => {
    h.selfHostVectorIndexName.mockReturnValue('idx-name');
    mockClient.indexExists.mockResolvedValue(true);
    mockClient.knnQuery.mockResolvedValue([
      { id: 'c1', score: 0.9, source: { text: 'hello', metadata: { fabFileId: 'f1' } } },
      { id: 'c2', score: 0.8, source: { text: 'world', metadata: { fabFileId: 'f1' } } },
    ]);

    const result = await openSearchChunkAdapter.knnSearch(['f1'], [0.1, 0.2], 'text-embedding-3-small', { limit: 1 });

    expect(mockClient.knnQuery).toHaveBeenCalledWith('idx-name', [0.1, 0.2], expect.any(Number), {
      filter: {
        bool: {
          filter: [
            { terms: { 'metadata.fabFileId': ['f1'] } },
            { term: { 'metadata.embeddingModel': 'text-embedding-3-small' } },
          ],
        },
      },
      size: 1,
      excludeSource: ['vector'],
    });
    // capped to the requested limit even though the mock returned 2 hits
    expect(result).toEqual([{ id: 'c1', fabFileId: 'f1', text: 'hello', score: 0.9 }]);
  });

  it('defaults limit to 50 when not provided', async () => {
    h.selfHostVectorIndexName.mockReturnValue('idx-name');
    mockClient.indexExists.mockResolvedValue(true);
    mockClient.knnQuery.mockResolvedValue([]);

    await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'text-embedding-3-small');

    const candidatePoolArg = mockClient.knnQuery.mock.calls[0][2];
    expect(candidatePoolArg).toBeGreaterThanOrEqual(100);
    expect(mockClient.knnQuery.mock.calls[0][3]).toMatchObject({ size: 50 });
  });

  it('memoizes a positive indexExists across queries for the same index, but not across different indexes', async () => {
    h.selfHostVectorIndexName.mockReturnValue('idx-name');
    mockClient.indexExists.mockResolvedValue(true);
    mockClient.knnQuery.mockResolvedValue([]);

    await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'text-embedding-3-small');
    await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'text-embedding-3-small');

    expect(mockClient.indexExists).toHaveBeenCalledTimes(1);

    h.selfHostVectorIndexName.mockReturnValue('idx-name-2');
    await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'a-different-model');
    expect(mockClient.indexExists).toHaveBeenCalledTimes(2);
  });

  it('does not memoize a negative indexExists - the very next call re-checks', async () => {
    h.selfHostVectorIndexName.mockReturnValue('idx-name-not-yet');
    mockClient.indexExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockClient.knnQuery.mockResolvedValue([]);

    const firstResult = await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'text-embedding-3-small');
    expect(firstResult).toEqual([]);
    expect(mockClient.knnQuery).not.toHaveBeenCalled();

    await openSearchChunkAdapter.knnSearch(['f1'], [0.1], 'text-embedding-3-small');
    expect(mockClient.indexExists).toHaveBeenCalledTimes(2);
    expect(mockClient.knnQuery).toHaveBeenCalledTimes(1);
  });
});
