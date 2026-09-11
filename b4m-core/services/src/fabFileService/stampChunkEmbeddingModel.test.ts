import { describe, it, expect, vi } from 'vitest';
import { stampChunkEmbeddingModel } from './stampChunkEmbeddingModel';

// Passthrough: these tests assert ordering and error-propagation between the two writes, not
// transaction atomicity itself (that's Mongoose's connection.transaction(), not this file's job).
vi.mock('@bike4mind/db-core', () => ({
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));

/**
 * Adapters with the chunk-label read stubbed to whatever the file's chunks declare. Defaults to the
 * single-model case, which is every ordinary ingest.
 */
const makeAdapters = (declaredModels: string[] = ['text-embedding-3-small']) => {
  const calls: string[] = [];
  const updateEmbeddingModel = vi.fn(async () => {
    calls.push('chunks');
  });
  const update = vi.fn(async () => {
    calls.push('file');
    return null;
  });
  const distinctEmbeddingModelsByFabFileId = vi.fn(async () => declaredModels);
  const warn = vi.fn();
  return {
    calls,
    updateEmbeddingModel,
    update,
    distinctEmbeddingModelsByFabFileId,
    warn,
    adapters: {
      db: { fabFiles: { update }, fabFileChunks: { updateEmbeddingModel, distinctEmbeddingModelsByFabFileId } },
      logger: { warn },
    },
  };
};

describe('stampChunkEmbeddingModel', () => {
  it('stamps the chunks first, then records the file-level readiness timestamp', async () => {
    const { adapters, calls, updateEmbeddingModel, update } = makeAdapters();

    await stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', adapters);

    expect(updateEmbeddingModel).toHaveBeenCalledWith('file-1', 'text-embedding-3-small');
    expect(update).toHaveBeenCalledWith({
      id: 'file-1',
      chunkEmbeddingModelStampedAt: expect.any(Date),
    });
    // Order matters: a reader must never see the readiness stamp before the chunks it vouches for.
    expect(calls).toEqual(['chunks', 'file']);
  });

  it('propagates a chunk-stamp failure without touching the file (never a false readiness signal)', async () => {
    const { adapters, update, updateEmbeddingModel } = makeAdapters();
    updateEmbeddingModel.mockRejectedValue(new Error('write failed'));

    await expect(stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', adapters)).rejects.toThrow(
      'write failed'
    );

    expect(update).not.toHaveBeenCalled();
  });

  it('folds an optional caller fileUpdate into the same file write as the readiness stamp', async () => {
    const { adapters, update } = makeAdapters();

    await stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', adapters, {
      vectorized: true,
      vectorizedChunkCount: 3,
      isVectorizing: false,
    });

    expect(update).toHaveBeenCalledWith({
      id: 'file-1',
      chunkEmbeddingModelStampedAt: expect.any(Date),
      vectorized: true,
      vectorizedChunkCount: 3,
      isVectorizing: false,
    });
  });

  describe('the FILE-level label is opt-in', () => {
    it('relabels the FILE with the model actually embedded when stampFile is set', async () => {
      // The regression this pins, caught on a live keyless preview: chunkFile stamps the file with
      // the deployment default (ada-002), the vectorize pass falls back to keyless Bedrock and
      // embeds with Titan, and the chunks get the Titan label. If the FILE keeps ada-002 the two
      // disagree, and every retrieval reader drops the file at the FILE level as foreign
      // (isForeignEmbeddingModel) without ever reading a chunk - a successfully embedded file
      // returns zero hits and reports itself as needing a re-embed.
      const { adapters, update, updateEmbeddingModel } = makeAdapters(['amazon.titan-embed-text-v2:0']);

      await stampChunkEmbeddingModel('file-1', 'amazon.titan-embed-text-v2:0', adapters, {
        vectorized: true,
        vectorizedChunkCount: 1,
        stampFile: true,
      });

      // Both labels come from the one argument, in one transaction, so they cannot drift apart.
      expect(updateEmbeddingModel).toHaveBeenCalledWith('file-1', 'amazon.titan-embed-text-v2:0');
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'amazon.titan-embed-text-v2:0' }));
    });

    it('leaves the FILE label alone when stampFile is absent, so a width GUESS cannot become exclusion authority', async () => {
      // The packages/scripts/datalake backfill is the caller that omits it. For a legacy file with
      // no recorded label it guesses a model from vector width and tiebreaks with the deployment
      // default, and ten registered models share 1024 dims - so the guess is frequently wrong.
      // Left on the chunks a wrong guess is harmless (a blank file label is never foreign); promoted
      // to the file level it would drop a healthy file from every search wholesale.
      const { adapters, update, distinctEmbeddingModelsByFabFileId } = makeAdapters();

      await stampChunkEmbeddingModel('legacy-file', 'amazon.titan-embed-text-v2:0', adapters);

      expect(update).toHaveBeenCalledWith({
        id: 'legacy-file',
        chunkEmbeddingModelStampedAt: expect.any(Date),
      });
      expect(update.mock.calls[0][0]).not.toHaveProperty('embeddingModel');
      // Not even read: no file label is being decided, so the divergence query is pure cost.
      expect(distinctEmbeddingModelsByFabFileId).not.toHaveBeenCalled();
    });
  });

  describe('a file whose chunks span two embedding spaces', () => {
    it('clears the FILE label rather than picking one of them, and says so', async () => {
      // A file's chunks fan across several vectorize messages that each resolve their own model, so
      // a credential appearing or lapsing mid-ingest genuinely splits the file across two models AND
      // two vector widths. Any single file label is then a lie about half the vectors; a blank one is
      // the only safe answer, because isForeignEmbeddingModel never excludes it and each chunk is
      // still matched on its own truthful label.
      const { adapters, update, warn } = makeAdapters(['text-embedding-ada-002', 'amazon.titan-embed-text-v2:0']);

      await stampChunkEmbeddingModel('split-file', 'amazon.titan-embed-text-v2:0', adapters, {
        vectorized: true,
        stampFile: true,
      });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: null }));
      // The operator's only signal that this happened at all - it is otherwise silent.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 embedding spaces'));
    });

    it('reads the declared models BEFORE opening the transaction', async () => {
      // `distinct` is only permitted inside a transaction on an unsharded collection, and the
      // session attaches itself automatically - so inside, this would start throwing the day
      // fabfilechunks is sharded, in the one place with no test against a real mongod. Reading
      // first costs nothing because the pending stamp can only ADD this message's model to the set,
      // which resolveFileLabel unions in.
      const { adapters, calls, distinctEmbeddingModelsByFabFileId } = makeAdapters();
      distinctEmbeddingModelsByFabFileId.mockImplementation(async () => {
        calls.push('read');
        return ['text-embedding-3-small'];
      });

      await stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', adapters, { stampFile: true });

      expect(calls).toEqual(['read', 'chunks', 'file']);
    });

    it("clears the label when every chunk declares a model OTHER than the caller's", async () => {
      // The mirror of the divergence case, and the reason the declared set is unioned rather than
      // the argument returned. If this message resolved Titan but had no embeddable chunks of its
      // own while the file's existing chunks all declare ada-002, stamping the file Titan would
      // label a file whose every vector is ada-002 - a wrong FILE label is exclusion authority, so
      // it strands the whole file. Clearing it keeps every chunk matched on its own truthful label.
      const { adapters, update } = makeAdapters(['text-embedding-ada-002']);

      await stampChunkEmbeddingModel('file-1', 'amazon.titan-embed-text-v2:0', adapters, { stampFile: true });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: null }));
    });

    it('labels the file from what the CHUNKS declare, not from the argument', async () => {
      const { adapters, update } = makeAdapters(['text-embedding-3-small']);

      await stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', adapters, { stampFile: true });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'text-embedding-3-small' }));
    });
  });
});
