import { describe, expect, it, vi } from 'vitest';
import { openSearchRetrievalIndex } from './openSearchRetrievalIndex';

const SCOPE = { datalakeTag: 'lake:1', fileTagPrefix: null };

const makePort = (modelsByFile: Record<string, string[]>, onDelete?: () => Promise<void>) => {
  const embeddingModelsByFabFileIds = vi.fn().mockResolvedValue(modelsByFile);
  const deleteByFabFileIdOrThrow = vi.fn(onDelete ?? (async () => undefined));
  return {
    embeddingModelsByFabFileIds,
    deleteByFabFileIdOrThrow,
    port: openSearchRetrievalIndex({
      db: { fabFileChunks: { embeddingModelsByFabFileIds } },
      searchIndex: { deleteByFabFileIdOrThrow },
    }),
  };
};

describe('openSearchRetrievalIndex.removeForDataLake', () => {
  it('deletes each file only from the models that file actually used (#2087)', async () => {
    // The pairing, not the union. Before this, models were resolved across the whole batch and every
    // file was paired with every model in it: f1 would also be deleted from model-b and f2 from
    // model-a, two requests that match nothing. At connector scale that doubles removal traffic.
    const { embeddingModelsByFabFileIds, deleteByFabFileIdOrThrow, port } = makePort({
      f1: ['model-a'],
      f2: ['model-b'],
    });

    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['f1', 'f2'] });

    expect(embeddingModelsByFabFileIds).toHaveBeenCalledWith(['f1', 'f2']);
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledTimes(2);
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f1', 'model-a');
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f2', 'model-b');
  });

  it('still covers every model of a file that spans more than one', async () => {
    // A file re-embedded onto a new model keeps chunks under the old one (see
    // IFabFileChunk.embeddingModel), so per-file must not collapse to one model per file.
    const { deleteByFabFileIdOrThrow, port } = makePort({ f1: ['model-a', 'model-b'] });

    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['f1'] });

    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledTimes(2);
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f1', 'model-a');
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f1', 'model-b');
  });

  it('skips a file absent from the map, which has no model-bearing chunks to remove', async () => {
    // f2 is requested but has no chunks under any model, so it appears in fabFileIds and not in the
    // map. Iterating the map is what drops it; iterating fabFileIds would issue a no-op request.
    const { deleteByFabFileIdOrThrow, port } = makePort({ f1: ['model-a'] });

    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['f1', 'f2'] });

    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledTimes(1);
    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledWith('f1', 'model-a');
  });

  it('does nothing for an empty fabFileIds list - no model lookup, no deletes', async () => {
    const { embeddingModelsByFabFileIds, deleteByFabFileIdOrThrow, port } = makePort({});

    await port.removeForDataLake({ scope: SCOPE, fabFileIds: [] });

    expect(embeddingModelsByFabFileIds).not.toHaveBeenCalled();
    expect(deleteByFabFileIdOrThrow).not.toHaveBeenCalled();
  });

  it('does nothing for a file set with no chunks under any model', async () => {
    const { deleteByFabFileIdOrThrow, port } = makePort({});

    await port.removeForDataLake({ scope: SCOPE, fabFileIds: ['f1'] });

    expect(deleteByFabFileIdOrThrow).not.toHaveBeenCalled();
  });

  // strictIndexRemove (the phase-2 purge) relies on this: a real OpenSearch failure must
  // propagate out of removeForDataLake so the purge aborts, rather than proceeding to
  // hard-delete Mongo rows the OpenSearch removal never actually completed.
  it('propagates a delete failure rather than swallowing it', async () => {
    const { port } = makePort({ f1: ['model-a'] }, async () => {
      throw new Error('cluster unreachable');
    });

    await expect(port.removeForDataLake({ scope: SCOPE, fabFileIds: ['f1'] })).rejects.toThrow('cluster unreachable');
  });

  it('bounds concurrency instead of firing every (file, model) pair in one unbounded burst', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const manyFileIds = Array.from({ length: 45 }, (_, i) => `f${i}`);
    const modelsByFile = Object.fromEntries(manyFileIds.map(id => [id, ['model-a']]));
    const { deleteByFabFileIdOrThrow, port } = makePort(modelsByFile, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
    });

    await port.removeForDataLake({ scope: SCOPE, fabFileIds: manyFileIds });

    expect(deleteByFabFileIdOrThrow).toHaveBeenCalledTimes(45);
    expect(maxInFlight).toBeLessThan(45);
  });
});
