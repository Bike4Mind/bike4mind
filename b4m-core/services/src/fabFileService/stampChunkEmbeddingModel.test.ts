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
    expect(update).toHaveBeenCalledWith({ id: 'file-1', chunkEmbeddingModelStampedAt: expect.any(Date) });
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
      chunkEmbeddingModelStampedAt: expect.any(Date),
      vectorized: true,
      vectorizedChunkCount: 3,
      isVectorizing: false,
    });
  });
});
