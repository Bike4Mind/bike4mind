import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository, fabFileChunkRepository } from './FabFileModel';

// #1802's own text: "Any fix should come with a DB-backed test covering the zero-chunk window
// specifically. Mocked worker tests cannot see this." This exercises the REAL sequence
// chunkFabfile performs against a file that extracts to zero chunks - the exact residual case the
// issue named (a file with nothing to delete/insert is where the old premature-release bug was
// invisible to the `chunked` guard) - using the real repositories, not mocks.
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('the zero-chunk window, against real repositories', () => {
  const makeClaimedFile = async (chunkClaimedAt: Date) =>
    FabFile.create({
      userId: 'u-zero-chunk',
      fileName: 'empty.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'empty.txt',
      isChunking: true,
      chunkClaimedAt,
    });

  it('a zero-chunk run: guard passes, rollup writes chunked:false/chunkCount:0, delete+insert of nothing both succeed, claim fields untouched', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    const file = await makeClaimedFile(stamp);
    const fabFileId = String(file._id);

    const confirmed = await fabFileRepository.confirmChunkClaim(fabFileId, stamp);
    expect(confirmed).toBe(true);

    // Mirrors chunk.ts's exact rollup payload shape for chunks.length === 0.
    await fabFileRepository.update({
      id: fabFileId,
      chunked: false,
      chunkCount: 0,
      chunkedCharCount: 0,
      maxChunkCharLength: 0,
      isVectorizing: false,
      vectorized: false,
      vectorizedChunkCount: 0,
      embeddedChunkCount: 0,
      embeddedCharCount: 0,
      embeddingModel: 'text-embedding-3-small',
      chunkEmbeddingModelStampedAt: null,
    });

    await fabFileChunkRepository.deleteManyByFabFileId(fabFileId);
    const inserted = await fabFileChunkRepository.bulkInsert([]);
    expect(inserted).toEqual([]);

    const reloaded = await FabFile.findById(fabFileId).lean();
    expect(reloaded?.chunked).toBe(false);
    expect(reloaded?.chunkCount).toBe(0);
    // The whole point of #1802: none of the above touched the worker's claim.
    expect(reloaded?.isChunking).toBe(true);
    expect(reloaded?.chunkClaimedAt?.toISOString()).toBe(stamp.toISOString());
  });

  it('a superseded zero-chunk run: the guard aborts BEFORE the rollup write, even though there is nothing destructive to protect', async () => {
    const originalStamp = new Date('2026-02-01T00:00:00.000Z');
    const successorStamp = new Date('2026-02-01T00:31:00.000Z');
    const file = await makeClaimedFile(successorStamp); // simulates a takeover having already landed

    const confirmed = await fabFileRepository.confirmChunkClaim(String(file._id), originalStamp);
    expect(confirmed).toBe(false);
    // The caller (chunk.ts) throws ChunkClaimLostError here and performs NO write - proven at the
    // unit level in chunk.test.ts; this test's job is only to prove the guard itself correctly
    // fails for a file that would have produced zero chunks, not just a file that produced some.

    const reloaded = await FabFile.findById(file._id).lean();
    expect(reloaded?.chunked).toBe(false); // untouched - no rollup was ever attempted
    expect(reloaded?.chunkClaimedAt?.toISOString()).toBe(successorStamp.toISOString());
  });
});
