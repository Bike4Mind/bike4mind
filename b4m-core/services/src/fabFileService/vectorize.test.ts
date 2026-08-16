import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { vectorizeFabFileChunk } from './vectorize';
import { NotFoundError } from '@bike4mind/utils';
import type { IUserDocument } from '@bike4mind/common';

describe('vectorizeFabFileChunk', () => {
  const mockUser = { id: 'user-1' } as IUserDocument;
  const mockFabFile = {
    id: 'file-1',
    chunkCount: 3,
    vectorizedChunkCount: 1,
    // The worker's live claim (mirrors chunk.test.ts's #1802 T2/T3 fixture): without these two
    // fields the "never writes X" assertions below would pass even against the pre-fix
    // whole-object write bug, since a spread of this fixture would have nothing to leak.
    isChunking: true,
    chunkClaimedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  const mockChunk = { id: 'chunk-1', text: 'hello world', vector: undefined as number[] | undefined };

  let mockAdapter: {
    db: {
      fabFiles: { shareable: { findAccessibleById: Mock }; update: Mock };
      fabFileChunks: { findById: Mock; update: Mock };
      users: { findById: Mock };
    };
    llm: { createVector: Mock };
    logger: { updateMetadata: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter = {
      db: {
        fabFiles: {
          shareable: { findAccessibleById: vi.fn().mockResolvedValue({ ...mockFabFile }) },
          update: vi.fn(),
        },
        fabFileChunks: {
          findById: vi.fn().mockResolvedValue({ ...mockChunk }),
          update: vi.fn(),
        },
        users: { findById: vi.fn() },
      },
      llm: { createVector: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) },
      logger: { updateMetadata: vi.fn() },
    };
  });

  it('writes an explicit payload with no isVectorizing key when not yet complete', async () => {
    await vectorizeFabFileChunk(mockUser, { fabFileId: 'file-1', chunkId: 'chunk-1' }, mockAdapter as never);

    const payload = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual({ id: 'file-1', vectorized: true, vectorizedChunkCount: 2 });
    expect(payload).not.toHaveProperty('isVectorizing');
  });

  it('never writes isChunking/chunkClaimedAt (#1802-class clobber, same as chunk.ts)', async () => {
    await vectorizeFabFileChunk(mockUser, { fabFileId: 'file-1', chunkId: 'chunk-1' }, mockAdapter as never);

    const payload = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('isChunking');
    expect(payload).not.toHaveProperty('chunkClaimedAt');
  });

  it('sets isVectorizing: false once the count reaches chunkCount', async () => {
    mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      ...mockFabFile,
      vectorizedChunkCount: 2,
    });

    await vectorizeFabFileChunk(mockUser, { fabFileId: 'file-1', chunkId: 'chunk-1' }, mockAdapter as never);

    const payload = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual({ id: 'file-1', vectorized: true, vectorizedChunkCount: 3, isVectorizing: false });
  });

  it('accumulates the count correctly from an undefined starting value', async () => {
    mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      ...mockFabFile,
      vectorizedChunkCount: undefined,
    });

    await vectorizeFabFileChunk(mockUser, { fabFileId: 'file-1', chunkId: 'chunk-1' }, mockAdapter as never);

    const payload = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.vectorizedChunkCount).toBe(1);
  });

  // Regression guard for the round-2-adjudicated fix: the write payload is built explicitly, but
  // the in-memory `fabFile` mutations must be kept too, or the RETURN VALUE silently stops
  // reflecting the write - this assertion fails if those mutation lines are ever dropped in favor
  // of "build payload only".
  it('returns the mutated fabFile, not the stale pre-write snapshot', async () => {
    const result = await vectorizeFabFileChunk(
      mockUser,
      { fabFileId: 'file-1', chunkId: 'chunk-1' },
      mockAdapter as never
    );

    expect(result.vectorized).toBe(true);
    expect(result.vectorizedChunkCount).toBe(2);
  });

  it('writes an explicit chunk payload of exactly {id, vector} - no other chunk field', async () => {
    await vectorizeFabFileChunk(mockUser, { fabFileId: 'file-1', chunkId: 'chunk-1' }, mockAdapter as never);

    const chunkPayload = mockAdapter.db.fabFileChunks.update.mock.calls[0][0] as Record<string, unknown>;
    expect(chunkPayload).toEqual({ id: 'chunk-1', vector: [0.1, 0.2, 0.3] });
  });

  it('throws NotFoundError and writes nothing when the chunk is not found', async () => {
    mockAdapter.db.fabFileChunks.findById.mockResolvedValue(null);

    await expect(
      vectorizeFabFileChunk(mockUser, { fabFileId: 'file-1', chunkId: 'missing' }, mockAdapter as never)
    ).rejects.toThrow(NotFoundError);

    expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
    expect(mockAdapter.db.fabFileChunks.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the fabFile is not accessible', async () => {
    mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue(null);

    await expect(
      vectorizeFabFileChunk(mockUser, { fabFileId: 'missing', chunkId: 'chunk-1' }, mockAdapter as never)
    ).rejects.toThrow(NotFoundError);
  });
});
