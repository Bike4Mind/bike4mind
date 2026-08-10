import { describe, expect, it, vi } from 'vitest';
import { openSearchRetrievalIndex } from './openSearchRetrievalIndex';

describe('openSearchRetrievalIndex.removeForDataLake', () => {
  it('resolves models from the chunk store and deletes every (file, model) pair', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn().mockResolvedValue(['model-a', 'model-b']);
    const deleteByFabFileId = vi.fn().mockResolvedValue(undefined);
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileId },
    });

    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: ['f1', 'f2'] });

    expect(distinctEmbeddingModelsByFabFileIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(deleteByFabFileId).toHaveBeenCalledTimes(4);
    expect(deleteByFabFileId).toHaveBeenCalledWith('f1', 'model-a');
    expect(deleteByFabFileId).toHaveBeenCalledWith('f1', 'model-b');
    expect(deleteByFabFileId).toHaveBeenCalledWith('f2', 'model-a');
    expect(deleteByFabFileId).toHaveBeenCalledWith('f2', 'model-b');
  });

  it('does nothing for an empty fabFileIds list - no model lookup, no deletes', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn();
    const deleteByFabFileId = vi.fn();
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileId },
    });

    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: [] });

    expect(distinctEmbeddingModelsByFabFileIds).not.toHaveBeenCalled();
    expect(deleteByFabFileId).not.toHaveBeenCalled();
  });

  it('does nothing for a file set with no chunks under any model', async () => {
    const distinctEmbeddingModelsByFabFileIds = vi.fn().mockResolvedValue([]);
    const deleteByFabFileId = vi.fn();
    const port = openSearchRetrievalIndex({
      db: { fabFileChunks: { distinctEmbeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileId },
    });

    await port.removeForDataLake({ scope: { datalakeTag: 'lake:1', fileTagPrefix: null }, fabFileIds: ['f1'] });

    expect(deleteByFabFileId).not.toHaveBeenCalled();
  });
});
