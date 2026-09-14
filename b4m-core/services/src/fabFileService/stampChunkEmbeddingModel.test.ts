import { describe, it, expect, vi } from 'vitest';
import { stampChunkEmbeddingModel } from './stampChunkEmbeddingModel';

// Passthrough: these tests assert ordering and error-propagation between the two writes, not
// transaction atomicity itself (that's Mongoose's connection.transaction(), not this file's job).
vi.mock('@bike4mind/db-core', () => ({
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));

/**
 * Adapters with the chunk-label read stubbed to whatever the file's chunks declare. Defaults to the
 * single-model case, which is every ordinary ingest - and to ZERO still-unlabeled vector-bearing
 * chunks, because the vectorize handler labels each chunk in the transaction that stores its vector,
 * so only legacy chunks and the backfill's input come back unlabeled.
 */
const makeAdapters = (declaredModels: string[] = ['text-embedding-3-small'], unlabeledVectorChunks = 0) => {
  const calls: string[] = [];
  const updateEmbeddingModel = vi.fn(async () => {
    calls.push('chunks');
  });
  const update = vi.fn(async () => {
    calls.push('file');
    return null;
  });
  const distinctEmbeddingModelsByFabFileId = vi.fn(async () => declaredModels);
  const countUnlabeledVectorChunksByFabFileId = vi.fn(async () => unlabeledVectorChunks);
  const warn = vi.fn();
  return {
    calls,
    updateEmbeddingModel,
    update,
    distinctEmbeddingModelsByFabFileId,
    countUnlabeledVectorChunksByFabFileId,
    warn,
    adapters: {
      db: {
        fabFiles: { update },
        fabFileChunks: {
          updateEmbeddingModel,
          distinctEmbeddingModelsByFabFileId,
          countUnlabeledVectorChunksByFabFileId,
        },
      },
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
      const { adapters, update, distinctEmbeddingModelsByFabFileId, countUnlabeledVectorChunksByFabFileId } =
        makeAdapters();

      await stampChunkEmbeddingModel('legacy-file', 'amazon.titan-embed-text-v2:0', adapters);

      expect(update).toHaveBeenCalledWith({
        id: 'legacy-file',
        chunkEmbeddingModelStampedAt: expect.any(Date),
      });
      expect(update.mock.calls[0][0]).not.toHaveProperty('embeddingModel');
      // Not even read: no file label is being decided, so the divergence queries are pure cost.
      expect(distinctEmbeddingModelsByFabFileId).not.toHaveBeenCalled();
      expect(countUnlabeledVectorChunksByFabFileId).not.toHaveBeenCalled();
    });
  });

  describe('a file whose chunks span two embedding spaces', () => {
    it('clears the FILE label rather than picking one of them, and says so', async () => {
      // A file's chunks fan across several vectorize messages that each resolve their own model, so
      // a credential appearing or lapsing mid-ingest genuinely splits the file across two models -
      // not necessarily two WIDTHS, since voyage-3 and Titan v2 are both 1024. Any single file label
      // is then a lie about half the vectors; a blank one is the only safe answer, because
      // isForeignEmbeddingModel never excludes it and each chunk is still matched on its own
      // truthful label (classifyLoadedChunk on the cosine arm, the filter clause on the Atlas one).
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

    it('clears the label when every chunk declares a model this message never wrote', async () => {
      // This message resolved Titan and its stamp will write nothing (no unlabeled vector-bearing
      // chunk remains), so every vector here came from an earlier writer declaring ada-002. That
      // those labels AGREE is not evidence they are RIGHT - the chunk-model backfill guesses a
      // legacy file's model from vector width - and promoting a guess to the file level is what
      // turns a harmless wrong label into a wholesale exclusion. Blank leaves the decision with the
      // per-chunk labels, which both cosine scans now read.
      const { adapters, update, warn } = makeAdapters(['text-embedding-ada-002'], 0);

      await stampChunkEmbeddingModel('file-1', 'amazon.titan-embed-text-v2:0', adapters, { stampFile: true });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: null }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not write'));
    });

    it("DOES vote the caller's model in when the pending stamp will actually write a row", async () => {
      // The other side of the same rule: an unlabeled vector-bearing chunk is one the stamp below is
      // about to label Titan, so after it commits the file genuinely holds both spaces and the label
      // must clear. Without this the union would be unreachable and a real mid-ingest credential
      // change would keep a label that is a lie about half the vectors.
      const { adapters, update, warn } = makeAdapters(['text-embedding-ada-002'], 3);

      await stampChunkEmbeddingModel('file-1', 'amazon.titan-embed-text-v2:0', adapters, { stampFile: true });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: null }));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('2 embedding spaces'));
    });

    it('labels the file when the chunks and this message name the same space', async () => {
      // The redelivery case: a file already fully embedded in this message's own model, so the
      // stamp has nothing left to write. The label is still this message's to vouch for, so it must
      // be produced rather than falling through to the cannot-vouch branch the sibling above covers.
      const { adapters, update } = makeAdapters(['text-embedding-ada-002']);

      await stampChunkEmbeddingModel('file-1', 'text-embedding-ada-002', adapters, { stampFile: true });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'text-embedding-ada-002' }));
    });

    it("labels the file when the pending stamp's own rows land in the space already declared", async () => {
      // The ordinary healthy promotion, and the reason the union is not simply a clearing rule: the
      // unlabeled vector-bearing chunks this stamp is about to write take THIS message's model,
      // which is the one the labeled chunks already declare. The set stays at one and is this
      // message's to vouch for, so the mixed-space branch must not fire merely because unlabeled
      // rows existed.
      const { adapters, update, warn } = makeAdapters(['text-embedding-ada-002'], 5);

      await stampChunkEmbeddingModel('file-1', 'text-embedding-ada-002', adapters, { stampFile: true });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'text-embedding-ada-002' }));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('a file that completes with nothing embedded', () => {
    it('clears the FILE label rather than stamping the model that embedded none of it', async () => {
      // Reachable, and the argument is pure fiction here. The vectorize handler drops every chunk
      // whose tokenCount exceeds the resolved model's context window, but `computeChunkVectorRollup`
      // counts an oversized chunk as TERMINAL - so a file made entirely of them reaches
      // `isFileVectorized` with an empty embed batch and still asks for the file label. Stamping it
      // from the argument gives a file with zero vectors a confident vector space, which is
      // exclusion authority derived from nothing, and it overwrites a truthful blank label to do it.
      const { adapters, update, warn } = makeAdapters([], 0);

      await stampChunkEmbeddingModel('empty-file', 'amazon.titan-embed-text-v2:0', adapters, {
        vectorized: true,
        vectorizedChunkCount: 4,
        stampFile: true,
      });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: null }));
      // Otherwise silent: the handler already logged the per-chunk skips, but nothing says the file
      // as a whole finished with no vectors.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no vector-bearing chunks'));
    });

    it('distinguishes "no vectors" from "vectors not labelled yet" and labels the second', async () => {
      // Both come back as an EMPTY declared set - the distinct query only sees chunks that already
      // carry a label - and they want opposite answers. A legacy file, or the chunk-model backfill's
      // input, has real vectors that the stamp below is about to label; clearing the file label there
      // withholds a truthful one from a healthy file and tells the operator to re-upload it.
      const { adapters, update, warn } = makeAdapters([], 12);

      await stampChunkEmbeddingModel('legacy-file', 'amazon.titan-embed-text-v2:0', adapters, {
        vectorized: true,
        vectorizedChunkCount: 12,
        stampFile: true,
      });

      expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'amazon.titan-embed-text-v2:0' }));
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
