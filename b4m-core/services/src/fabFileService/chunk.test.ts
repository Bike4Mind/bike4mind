import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { chunkFabfile } from './chunk';
import { ChunkClaimLostError } from '@bike4mind/common';
import type { IUserDocument } from '@bike4mind/common';

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return { ...actual, SmartChunker: vi.fn() };
});

import { SmartChunker } from '@bike4mind/utils';

describe('chunkFabfile', () => {
  const mockUser = { id: 'user-1' } as IUserDocument;
  const mockFabFile = {
    id: 'file-1',
    embeddingModel: 'text-embedding-ada-002',
    mimeType: 'text/plain',
    // The worker's live claim on the loaded document (#1802 T2/T3) - without these two fields, the
    // "never writes X" tests below pass even against the pre-fix bug (a spread of this fixture has
    // nothing to leak, since the fixture never carried them).
    isChunking: true,
    chunkClaimedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  let mockAdapter: {
    db: {
      fabFiles: { shareable: { findAccessibleById: Mock }; update: Mock; confirmChunkClaim: Mock };
      fabFileChunks: {
        deleteManyByFabFileId: Mock;
        bulkInsert: Mock;
        update: Mock;
        distinctEmbeddingModelsByFabFileIds: Mock;
      };
      users: { findById: Mock };
    };
    storage: { getContentAsBuffer: Mock };
    logger: { updateMetadata: Mock; log: Mock; warn: Mock };
    searchIndex?: { deleteByFabFileId: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        chunkFile: vi.fn().mockResolvedValue([{ text: 'chunk one', tokenCount: 2 }]),
        freeEncoder: vi.fn(),
      };
    });

    mockAdapter = {
      db: {
        fabFiles: {
          shareable: { findAccessibleById: vi.fn().mockResolvedValue({ ...mockFabFile }) },
          update: vi.fn(),
          confirmChunkClaim: vi.fn().mockResolvedValue(true),
        },
        fabFileChunks: {
          deleteManyByFabFileId: vi.fn(),
          bulkInsert: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
          distinctEmbeddingModelsByFabFileIds: vi.fn().mockResolvedValue([]),
        },
        users: { findById: vi.fn() },
      },
      storage: { getContentAsBuffer: vi.fn() },
      logger: { updateMetadata: vi.fn(), log: vi.fn(), warn: vi.fn() },
    };
  });

  it('deletes every OLD model the chunk store actually used, not just FabFile.embeddingModel, and not the new one being written', async () => {
    // A file re-embedded more than once can have chunks under more than one prior model (see
    // IFabFileChunk.embeddingModel) - fabFile.embeddingModel alone is only the CURRENT one.
    mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds.mockResolvedValue([
      'text-embedding-ada-002',
      'text-embedding-3-small-old',
    ]);
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn().mockResolvedValue(undefined) };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds).toHaveBeenCalledWith(['file-1']);
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledTimes(2);
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-ada-002');
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-3-small-old');
  });

  it('skips the delete calls when the chunk store has no prior models for this file', async () => {
    mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds.mockResolvedValue([]);
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn() };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.searchIndex.deleteByFabFileId).not.toHaveBeenCalled();
  });

  it('is a no-op when searchIndex is not provided (non-self-host) - never even queries the chunk store', async () => {
    const result = await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );
    expect(mockAdapter.db.fabFileChunks.bulkInsert).toHaveBeenCalled();
    expect(mockAdapter.db.fabFileChunks.distinctEmbeddingModelsByFabFileIds).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  // Rejecting at the boundary is what keeps an unmatchable label out of the database: this is the
  // only writer of FabFile.embeddingModel, and a mis-cased value reads as positively FOREIGN to the
  // readers rather than unknown. See isForeignEmbeddingModel (dataLakeService/embeddingMismatch.ts)
  // for those readers and the reasoning. The `embeddingModel` in the message proves it was the
  // schema that rejected it, not something failing later in the chunker.
  it.each([
    ['mis-cased', 'Text-Embedding-3-Small'],
    ['unrecognized', 'not-a-real-embedder'],
    ['blank', ''],
  ])('rejects a %s embedding model without writing anything', async (_label, embeddingModel) => {
    await expect(chunkFabfile(mockUser, { fabFileId: 'file-1', embeddingModel }, mockAdapter as never)).rejects.toThrow(
      /embeddingModel/
    );

    expect(mockAdapter.db.fabFiles.shareable.findAccessibleById).not.toHaveBeenCalled();
    expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
    expect(mockAdapter.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(mockAdapter.db.fabFileChunks.bulkInsert).not.toHaveBeenCalled();
  });

  it('stamps charLength (code points) on every inserted chunk and their sum on the file', async () => {
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        chunkFile: vi.fn().mockResolvedValue([
          { text: 'chunk one', tokenCount: 2 }, // 9 code points
          { text: 'four\u{1F600}', tokenCount: 2 }, // 5 code points, 6 UTF-16 units
        ]),
        freeEncoder: vi.fn(),
      };
    });

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const inserted = mockAdapter.db.fabFileChunks.bulkInsert.mock.calls[0][0] as Array<{ charLength: number }>;
    expect(inserted.map(c => c.charLength)).toEqual([9, 5]);

    const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as { chunkedCharCount: number };
    expect(updatedFile.chunkedCharCount).toBe(14);
  });

  // #1802: chunkFabfile released its OWN claim mid-run (isChunking: false) before the destructive
  // delete, opening a window for a concurrent delivery to pass the worker's CAS. The claim is now
  // owned solely by the worker (fabFileChunk.ts) - chunkFabfile must never write either field.
  it('never writes isChunking - the claim survives the run (#1802 T1)', async () => {
    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const updatePayload = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updatePayload).not.toHaveProperty('isChunking');
  });

  it('never writes chunkClaimedAt - a stale predecessor cannot stamp over a successor (#1802 T2/T3)', async () => {
    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const updatePayload = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updatePayload).not.toHaveProperty('chunkClaimedAt');
  });

  // #1802 Phase 2: the guarded-write ownership check. A superseded run must abort BEFORE any write
  // of its own - including the rollup update below, not just the destructive delete/insert further
  // down - so a stale run can never leave the FabFile document describing chunks it never actually
  // wrote.
  describe('guarded-write ownership check (#1802 Phase 2)', () => {
    it('confirms the claim it was called with before writing anything (T4)', async () => {
      const claimedAt = new Date('2026-01-01T00:00:00.000Z');
      await chunkFabfile(
        mockUser,
        { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002', chunkClaimedAt: claimedAt },
        mockAdapter as never
      );

      expect(mockAdapter.db.fabFiles.confirmChunkClaim).toHaveBeenCalledWith('file-1', claimedAt);
    });

    it('throws ChunkClaimLostError and performs no write at all when the claim was lost (T4)', async () => {
      mockAdapter.db.fabFiles.confirmChunkClaim.mockResolvedValue(false);

      await expect(
        chunkFabfile(
          mockUser,
          { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002', chunkClaimedAt: new Date() },
          mockAdapter as never
        )
      ).rejects.toThrow(ChunkClaimLostError);

      expect(mockAdapter.db.fabFiles.update).not.toHaveBeenCalled();
      expect(mockAdapter.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
      expect(mockAdapter.db.fabFileChunks.bulkInsert).not.toHaveBeenCalled();
    });

    it('skips the check entirely when no claim stamp is supplied (backward-compatible no-op)', async () => {
      await chunkFabfile(
        mockUser,
        { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
        mockAdapter as never
      );

      expect(mockAdapter.db.fabFiles.confirmChunkClaim).not.toHaveBeenCalled();
      expect(mockAdapter.db.fabFiles.update).toHaveBeenCalled();
      // The sole production caller always supplies a stamp - this only fires for a future in-repo
      // caller that doesn't, so it must be loud rather than silent.
      expect(mockAdapter.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no claim stamp'));
    });
  });
});
