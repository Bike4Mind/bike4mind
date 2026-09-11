import { describe, it, expect, vi } from 'vitest';
import { stampChunkEmbeddingModel } from './stampChunkEmbeddingModel';

// Passthrough: these tests assert ordering and error-propagation between the two writes, not
// transaction atomicity itself (that's Mongoose's connection.transaction(), not this file's job).
vi.mock('@bike4mind/db-core', () => ({
  withTransaction: vi.fn((fn: () => unknown) => fn()),
}));

describe('stampChunkEmbeddingModel', () => {
  it('stamps the chunks first, then records the file-level readiness timestamp', async () => {
    const calls: string[] = [];
    const updateEmbeddingModel = vi.fn(async () => {
      calls.push('chunks');
    });
    const update = vi.fn(async () => {
      calls.push('file');
      return null;
    });

    await stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', {
      db: { fabFiles: { update }, fabFileChunks: { updateEmbeddingModel } },
    });

    expect(updateEmbeddingModel).toHaveBeenCalledWith('file-1', 'text-embedding-3-small');
    expect(update).toHaveBeenCalledWith({
      id: 'file-1',
      embeddingModel: 'text-embedding-3-small',
      chunkEmbeddingModelStampedAt: expect.any(Date),
    });
    // Order matters: a reader must never see the readiness stamp before the chunks it vouches for.
    expect(calls).toEqual(['chunks', 'file']);
  });

  it('propagates a chunk-stamp failure without touching the file (never a false readiness signal)', async () => {
    const updateEmbeddingModel = vi.fn().mockRejectedValue(new Error('write failed'));
    const update = vi.fn();

    await expect(
      stampChunkEmbeddingModel('file-1', 'text-embedding-3-small', {
        db: { fabFiles: { update }, fabFileChunks: { updateEmbeddingModel } },
      })
    ).rejects.toThrow('write failed');

    expect(update).not.toHaveBeenCalled();
  });

  it('folds an optional caller fileUpdate into the same file write as the readiness stamp', async () => {
    const updateEmbeddingModel = vi.fn();
    const update = vi.fn().mockResolvedValue(null);

    await stampChunkEmbeddingModel(
      'file-1',
      'text-embedding-3-small',
      { db: { fabFiles: { update }, fabFileChunks: { updateEmbeddingModel } } },
      { vectorized: true, vectorizedChunkCount: 3, isVectorizing: false }
    );

    expect(update).toHaveBeenCalledWith({
      id: 'file-1',
      embeddingModel: 'text-embedding-3-small',
      chunkEmbeddingModelStampedAt: expect.any(Date),
      vectorized: true,
      vectorizedChunkCount: 3,
      isVectorizing: false,
    });
  });

  it('relabels the FILE with the model actually embedded, not the one chunkFile recorded', async () => {
    // The regression this pins, caught on a live keyless preview: chunkFile stamps the file with
    // the deployment default (ada-002), the vectorize pass falls back to keyless Bedrock and
    // embeds with Titan, and the chunks get the Titan label. If the FILE keeps ada-002 the two
    // disagree, and every retrieval reader drops the file at the FILE level as foreign
    // (isForeignEmbeddingModel) without ever reading a chunk - a successfully embedded file
    // returns zero hits and reports itself as needing a re-embed.
    const updateEmbeddingModel = vi.fn();
    const update = vi.fn().mockResolvedValue(null);

    await stampChunkEmbeddingModel(
      'file-1',
      'amazon.titan-embed-text-v2:0',
      { db: { fabFiles: { update }, fabFileChunks: { updateEmbeddingModel } } },
      { vectorized: true, vectorizedChunkCount: 1 }
    );

    // Both labels come from the one argument, in one transaction, so they cannot drift apart.
    expect(updateEmbeddingModel).toHaveBeenCalledWith('file-1', 'amazon.titan-embed-text-v2:0');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ embeddingModel: 'amazon.titan-embed-text-v2:0' }));
  });
});
