import { describe, expect, it, vi } from 'vitest';
import { atlasVectorSearch } from './atlasVectorSearch';

const fileById = new Map([
  ['f1', { fileName: 'a.pdf', fileTags: ['x'] }],
  ['f2', { fileName: 'b.pdf', fileTags: [] }],
]);

describe('atlasVectorSearch', () => {
  it('returns empty without calling the adapter when there are no eligible files', async () => {
    const vectorSearch = vi.fn();
    const result = await atlasVectorSearch({
      fileIds: [],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0,
      adapters: { vectorSearch },
    });
    expect(result).toEqual({ results: [], hitsReturned: 0, hitsSkippedUnknownFile: 0, filesWithHits: new Set() });
    expect(vectorSearch).not.toHaveBeenCalled();
  });

  it('shapes hits into SemanticChunkResult rows using the parent file metadata', async () => {
    const vectorSearch = vi.fn().mockResolvedValue([{ id: 'c1', fabFileId: 'f1', text: 'hello', score: 0.9 }]);
    const result = await atlasVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0,
      adapters: { vectorSearch },
    });
    expect(result.results).toEqual([
      { chunkId: 'c1', fileId: 'f1', fileName: 'a.pdf', fileTags: ['x'], chunkText: 'hello', score: 0.8 },
    ]);
    expect(result.hitsReturned).toBe(1);
    expect(result.hitsSkippedUnknownFile).toBe(0);
  });

  it('denormalizes Atlas cosine score (1+cos)/2 back to raw cosine before scoring', async () => {
    const vectorSearch = vi.fn().mockResolvedValue([
      { id: 'c1', fabFileId: 'f1', text: 'perfect match', score: 1 },
      { id: 'c2', fabFileId: 'f1', text: 'orthogonal', score: 0.5 },
      { id: 'c3', fabFileId: 'f1', text: 'opposite', score: 0 },
    ]);
    const result = await atlasVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: -1,
      adapters: { vectorSearch },
    });
    expect(result.results.map(r => r.score)).toEqual([1, 0, -1]);
  });

  it('drops a hit for a file no longer in scope', async () => {
    const vectorSearch = vi.fn().mockResolvedValue([{ id: 'c1', fabFileId: 'unknown-file', text: 'x', score: 0.9 }]);
    const result = await atlasVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0,
      adapters: { vectorSearch },
    });
    expect(result.results).toEqual([]);
    expect(result.hitsSkippedUnknownFile).toBe(1);
  });

  it('re-applies minScore since $vectorSearch limit bounds by rank, not by score', async () => {
    const vectorSearch = vi.fn().mockResolvedValue([
      { id: 'c1', fabFileId: 'f1', text: 'good', score: 0.9 },
      { id: 'c2', fabFileId: 'f2', text: 'weak', score: 0.1 },
    ]);
    const result = await atlasVectorSearch({
      fileIds: ['f1', 'f2'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0.5,
      adapters: { vectorSearch },
    });
    expect(result.results.map(r => r.chunkId)).toEqual(['c1']);
  });

  it('passes model and limit through to the adapter', async () => {
    const vectorSearch = vi.fn().mockResolvedValue([]);
    await atlasVectorSearch({
      fileIds: ['f1'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 7,
      minScore: 0,
      adapters: { vectorSearch },
    });
    expect(vectorSearch).toHaveBeenCalledWith(['f1'], [1, 2, 3], 'text-embedding-3-small', { limit: 7 });
  });

  it('marks a file as covered by a raw hit even when minScore then filters that hit out', async () => {
    // filesWithHits answers "did the index return anything for this file", not "did it score
    // well" - a low-scoring hit still proves the file's chunks are indexed.
    const vectorSearch = vi.fn().mockResolvedValue([{ id: 'c1', fabFileId: 'f2', text: 'weak', score: 0.1 }]);
    const result = await atlasVectorSearch({
      fileIds: ['f1', 'f2'],
      fileById,
      queryVector: [1, 2, 3],
      model: 'text-embedding-3-small',
      limit: 10,
      minScore: 0.5,
      adapters: { vectorSearch },
    });
    expect(result.results).toEqual([]);
    expect(result.filesWithHits).toEqual(new Set(['f2']));
  });
});
