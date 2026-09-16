import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { chunkFabfile, commitFabFileChunks, prepareFabFileChunks } from './chunk';
import { CHUNK_STALL_REASONS, ChunkClaimLostError } from '@bike4mind/common';
import { computeServerTextHash } from '../dataLakeService/admissionContract';
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
        distinctRetrievalIndexModelsByFabFileIds: Mock;
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
        getExtractedText: vi.fn().mockReturnValue('chunk one'),
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
          distinctRetrievalIndexModelsByFabFileIds: vi.fn().mockResolvedValue([]),
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
    mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds.mockResolvedValue([
      'text-embedding-ada-002',
      'text-embedding-3-small-old',
    ]);
    mockAdapter.searchIndex = { deleteByFabFileId: vi.fn().mockResolvedValue(undefined) };

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-3-small' },
      mockAdapter as never
    );

    expect(mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds).toHaveBeenCalledWith(['file-1']);
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledTimes(2);
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-ada-002');
    expect(mockAdapter.searchIndex.deleteByFabFileId).toHaveBeenCalledWith('file-1', 'text-embedding-3-small-old');
  });

  it('skips the delete calls when the chunk store has no prior models for this file', async () => {
    mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds.mockResolvedValue([]);
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
    expect(mockAdapter.db.fabFileChunks.distinctRetrievalIndexModelsByFabFileIds).not.toHaveBeenCalled();
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
        getExtractedText: vi.fn().mockReturnValue('chunk one four\u{1F600}'),
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

  it('stamps the server-verified text hash over the CANONICAL EXTRACTED TEXT, not the chunk output (admission contract #1679)', async () => {
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        // Chunk output is deliberately unlike the extracted text (policy-dependent boundaries); the
        // hash must derive from getExtractedText, so a mismatch here would fail the assertion.
        chunkFile: vi.fn().mockResolvedValue([
          { text: 'the quick', tokenCount: 2 },
          { text: 'brown fox jumps', tokenCount: 3 },
        ]),
        getExtractedText: vi.fn().mockReturnValue('the quick brown fox jumps'),
        freeEncoder: vi.fn(),
      };
    });

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as { serverTextHash?: string };
    expect(updatedFile.serverTextHash).toBe(computeServerTextHash('the quick brown fox jumps'));
    expect(updatedFile.serverTextHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('clears serverTextHash to null for a file that yields no extractable text', async () => {
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        chunkFile: vi.fn().mockResolvedValue([]),
        getExtractedText: vi.fn().mockReturnValue(undefined),
        freeEncoder: vi.fn(),
      };
    });

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as {
      serverTextHash?: string | null;
    };
    // null, not undefined: db.update does a full-document $set and Mongoose strips undefined, so
    // undefined would leave any prior hash in place (see next test).
    expect(updatedFile.serverTextHash).toBeNull();
  });

  it('nulls a previously-stamped serverTextHash when a re-chunk yields no text (never outlives its text)', async () => {
    // A reprocess resets chunked/chunkCount but not serverTextHash; if extraction now yields nothing
    // (parser regression, mimeType change), the full-document $set must not re-persist the old hash.
    const stale = 'a'.repeat(64);
    mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      ...mockFabFile,
      serverTextHash: stale,
    });
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        chunkFile: vi.fn().mockResolvedValue([]),
        getExtractedText: vi.fn().mockReturnValue(undefined),
        freeEncoder: vi.fn(),
      };
    });

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as {
      serverTextHash?: string | null;
    };
    expect(updatedFile.serverTextHash).toBeNull();
    expect(updatedFile.serverTextHash).not.toBe(stale);
  });

  // The root-cause half of the "repaired file stays withheld forever" defect. The RESCUE SWEEP
  // enqueues without a reset, so before this a fully re-chunked and re-vectorized file kept its
  // kill-switch marker - and every reader keying on it went on treating the file as broken.
  it('clears a convergence kill-switch marker when a rebuild succeeds', async () => {
    for (const chunkStallReason of CHUNK_STALL_REASONS) {
      mockAdapter.db.fabFiles.update.mockClear();
      mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({ ...mockFabFile, chunkStallReason });

      await chunkFabfile(
        mockUser,
        { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
        mockAdapter as never
      );

      const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as { chunkStallReason?: string | null };
      expect(updatedFile.chunkStallReason).toBeNull();
    }
  });

  // #2016: the markers moved off `notes` precisely so no pipeline write can touch the owner's own
  // text. The key must be ABSENT, not empty - `toBeUndefined` alone would also pass for
  // `notes: undefined`, and this asserts the commit never names the field at all.
  it("never writes notes - the owner's note survives a re-chunk", async () => {
    mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({
      ...mockFabFile,
      notes: 'my own note about this contract',
      chunkStallReason: 'rechunkPaused',
    });

    await chunkFabfile(
      mockUser,
      { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
      mockAdapter as never
    );

    const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
    expect('notes' in updatedFile).toBe(false);
  });

  // #1939. Unconditional, like the stall-reason clear above: the field carries exactly one fact and
  // this run IS the rebuild it recorded. Left set, a fully rebuilt file reads as in-flight forever -
  // withheld from search, parked as unmeasured in health, skipped by convergence.
  it('always clears the pending-rebuild stamp, whether or not a marker was present', async () => {
    for (const chunkStallReason of [null, 'rechunkPaused'] as const) {
      mockAdapter.db.fabFiles.update.mockClear();
      mockAdapter.db.fabFiles.shareable.findAccessibleById.mockResolvedValue({ ...mockFabFile, chunkStallReason });

      await chunkFabfile(
        mockUser,
        { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
        mockAdapter as never
      );

      const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as Record<string, unknown>;
      expect(updatedFile.chunkRebuildRequestedAt).toBeNull();
    }
  });
});

// #1681 constraint 3: the phase split is only worth anything if `prepareFabFileChunks` really is
// write-free - a single stray write in it would be a write outside the caller's transaction, which
// is strictly worse than the problem the split solves.
describe('prepareFabFileChunks / commitFabFileChunks (#1681)', () => {
  const mockUser = { id: 'user-1' } as IUserDocument;
  const mockFabFile = { id: 'file-1', embeddingModel: 'text-embedding-ada-002', mimeType: 'text/plain' };
  const embeddingModel = 'text-embedding-ada-002';

  const makeAdapter = () => ({
    db: {
      fabFiles: {
        shareable: { findAccessibleById: vi.fn().mockResolvedValue({ ...mockFabFile }) },
        update: vi.fn(),
        confirmChunkClaim: vi.fn().mockResolvedValue(true),
      },
      fabFileChunks: {
        deleteManyByFabFileId: vi.fn(),
        bulkInsert: vi.fn().mockResolvedValue([{ id: 'c1' }]),
        update: vi.fn(),
        distinctRetrievalIndexModelsByFabFileIds: vi.fn().mockResolvedValue([]),
      },
      users: { findById: vi.fn() },
    },
    storage: { getContentAsBuffer: vi.fn() },
    logger: { updateMetadata: vi.fn(), log: vi.fn(), warn: vi.fn() },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
      return {
        chunkFile: vi.fn().mockResolvedValue([{ text: 'chunk one', tokenCount: 2 }]),
        getExtractedText: vi.fn().mockReturnValue('chunk one'),
        freeEncoder: vi.fn(),
      };
    });
  });

  it('performs no writes while fetching and tokenizing', async () => {
    const adapter = makeAdapter();

    const prepared = await prepareFabFileChunks(mockUser, { fabFileId: 'file-1', embeddingModel }, adapter as never);

    expect(prepared.chunks).toHaveLength(1);
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
    expect(adapter.db.fabFiles.confirmChunkClaim).not.toHaveBeenCalled();
    expect(adapter.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
    expect(adapter.db.fabFileChunks.bulkInsert).not.toHaveBeenCalled();
  });

  it('re-chunks nothing on commit, so a retried transaction never re-downloads or re-tokenizes', async () => {
    const adapter = makeAdapter();
    const prepared = await prepareFabFileChunks(mockUser, { fabFileId: 'file-1', embeddingModel }, adapter as never);
    (SmartChunker as unknown as Mock).mockClear();

    await commitFabFileChunks(prepared, adapter as never);
    await commitFabFileChunks(prepared, adapter as never);

    expect(SmartChunker).not.toHaveBeenCalled();
    expect(adapter.db.fabFileChunks.bulkInsert).toHaveBeenCalledTimes(2);
  });

  it('still throws ChunkClaimLostError from the commit phase when the claim was superseded', async () => {
    const adapter = makeAdapter();
    const claimedAt = new Date('2026-01-01T00:00:00.000Z');
    const prepared = await prepareFabFileChunks(
      mockUser,
      { fabFileId: 'file-1', embeddingModel, chunkClaimedAt: claimedAt },
      adapter as never
    );
    adapter.db.fabFiles.confirmChunkClaim.mockResolvedValue(false);

    await expect(commitFabFileChunks(prepared, adapter as never)).rejects.toThrow(ChunkClaimLostError);
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
    expect(adapter.db.fabFileChunks.deleteManyByFabFileId).not.toHaveBeenCalled();
  });
});
