import { describe, expect, it, vi } from 'vitest';
import { openSearchVectorSearch } from './openSearchVectorSearch';

const fileById = new Map([
  ['f1', { fileName: 'a.pdf', fileTags: ['x'] }],
  ['f2', { fileName: 'b.pdf', fileTags: [] }],
]);

describe('openSearchVectorSearch', () => {
  it('returns empty without calling the adapter when there are no eligible files', async () => {
    const knnSearch = vi.fn();
    const result = await openSearchVectorSearch({
      fileIds: [],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0,
      adapters: { knnSearch },
    });
    expect(result).toEqual({ results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set() });
    expect(knnSearch).not.toHaveBeenCalled();
  });

  it('shapes hits into SemanticChunkResult rows using the parent file metadata', async () => {
    const knnSearch = vi.fn().mockResolvedValue([{ id: 'c1', fabFileId: 'f1', text: 'hello', score: 0.9 }]);
    const result = await openSearchVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0,
      adapters: { knnSearch },
    });
    expect(result.results).toEqual([
      { chunkId: 'c1', fileId: 'f1', fileName: 'a.pdf', fileTags: ['x'], chunkText: 'hello', score: 0.8 },
    ]);
    expect(result.hitsReturned).toBe(1);
    expect(result.hitsSkippedUnknownFile).toBe(0);
  });

  it('denormalizes the lucene/cosinesimil (1+cos)/2 score back to raw cosine before scoring', async () => {
    const knnSearch = vi.fn().mockResolvedValue([
      { id: 'c1', fabFileId: 'f1', text: 'perfect match', score: 1 },
      { id: 'c2', fabFileId: 'f1', text: 'orthogonal', score: 0.5 },
      { id: 'c3', fabFileId: 'f1', text: 'opposite', score: 0 },
    ]);
    const result = await openSearchVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: -1,
      adapters: { knnSearch },
    });
    expect(result.results.map(r => r.score)).toEqual([1, 0, -1]);
  });

  it('drops a hit for a file no longer in scope', async () => {
    const knnSearch = vi.fn().mockResolvedValue([{ id: 'c1', fabFileId: 'unknown-file', text: 'x', score: 0.9 }]);
    const result = await openSearchVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0,
      adapters: { knnSearch },
    });
    expect(result.results).toEqual([]);
    expect(result.hitsSkippedUnknownFile).toBe(1);
  });

  it('re-applies minScore since the kNN limit bounds by rank, not by score', async () => {
    const knnSearch = vi.fn().mockResolvedValue([
      { id: 'c1', fabFileId: 'f1', text: 'good', score: 0.9 },
      { id: 'c2', fabFileId: 'f2', text: 'weak', score: 0.1 },
    ]);
    const result = await openSearchVectorSearch({
      fileIds: ['f1', 'f2'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0.5,
      adapters: { knnSearch },
    });
    expect(result.results.map(r => r.chunkId)).toEqual(['c1']);
  });

  it('passes model and limit through to the adapter', async () => {
    const knnSearch = vi.fn().mockResolvedValue([]);
    await openSearchVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 7,
      minScore: 0,
      adapters: { knnSearch },
    });
    expect(knnSearch).toHaveBeenCalledWith(['f1'], [1, 2, 3], 'text-embedding-3-small', { limit: 7 });
  });

  it('marks a file as covered by a raw hit even when minScore then filters that hit out', async () => {
    const knnSearch = vi.fn().mockResolvedValue([{ id: 'c1', fabFileId: 'f2', text: 'weak', score: 0.1 }]);
    const result = await openSearchVectorSearch({
      fileIds: ['f1', 'f2'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0.5,
      adapters: { knnSearch },
    });
    expect(result.results).toEqual([]);
    expect(result.filesWithHits).toEqual(new Set(['f2']));
  });
});
