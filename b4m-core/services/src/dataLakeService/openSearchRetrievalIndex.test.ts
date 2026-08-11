import { describe, expect, it, vi } from 'vitest';
import { openSearchRetrievalIndex } from './openSearchRetrievalIndex';

describe('openSearchRetrievalIndex.removeForDataLake', () => {
  it('resolves models from the chunk store and deletes every (file, model) pair', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn().mockResolvedValue(['model-a', 'model-b']);
    const deleteByFabFileIdOrThrow = vi.fn().mockResolvedValue(undefined);
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileIdOrThrow },
    });

    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: ['f1', 'f2'] });

    expect(distinctEmbeddingModelsByFabFileIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledTimes(4);
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f1', 'model-a');
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f1', 'model-b');
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f2', 'model-a');
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f2', 'model-b');
  });

  it('does nothing for an empty fabFileIds list - no model lookup, no deletes', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn();
    const deleteByFabFileIdOrThrow = vi.fn();
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileIdOrThrow },
    });

    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: [] });

    expect(distinctEmbeddingModelsByFabFileIds).not.toHaveBeenCalled();
    expect(deleteByFabFileIdOrThrow).not.toHaveBeenCalled();
  });

  it('does nothing for a file set with no chunks under any model', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn().mockResolvedValue([]);
    const deleteByFabFileIdOrThrow = vi.fn();
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileIdOrThrow },
    });

    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: ['f1'] });

    expect(deleteByFabFileIdOrThrow).not.toHaveBeenCalled();
  });

  // strictIndexRemove (the phase-2 purge) relies on this: a real OpenSearch failure must
  // propagate out of removeForDataLake so the purge aborts, rather than proceeding to
  // hard-delete Mongo rows the OpenSearch removal never actually completed.
  it('propagates a delete failure rather than swallowing it', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn().mockResolvedValue(['model-a']);
    const deleteByFabFileIdOrThrow = vi.fn().mockRejectedValue(new Error('cluster unreachable'));
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileIdOrThrow },
    });

    await expect(
      port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: ['f1'] })
    ).rejects.toThrow('cluster unreachable');
  });

  it('bounds concurrency instead of firing every (file, model) pair in one unbounded burst', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn().mockResolvedValue(['model-a']);
    let inFlight = 0;
    let maxInFlight = 0;
    const deleteByFabFileIdOrThrow = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
    });
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileIdOrThrow },
    });

    const manyFileIds = Array.from({ length: 45 }, (_, i) => `f${i}`);
    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: manyFileIds });

    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledTimes(45);
    expect(maxInFlight).toBeLessThan(45);
  });
});
