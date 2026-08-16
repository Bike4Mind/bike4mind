import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({});
});

// #1802 Phase 2: the guarded-write ownership check chunkFabfile calls immediately before any
// write. Real Mongo, not a mock - correctness here depends on the write actually matching (or
// not) against a real document, not on a mock returning whatever a test tells it to.
describe('FabFileRepository.confirmChunkClaim', () => {
  const userId = 'u-claim';

  const makeFile = async (chunkClaimedAt: Date | null) =>
    FabFile.create({
      userId,
      fileName: 'a.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'a.txt',
      isChunking: true,
      chunkClaimedAt,
    });

  it('returns true when the stamp still matches (T4: claim survives)', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    const file = await makeFile(stamp);

    const result = await fabFileRepository.confirmChunkClaim(String(file._id), stamp);
    expect(result).toBe(true);
  });

  it('returns false when a successor already re-stamped chunkClaimedAt (T4: stale takeover)', async () => {
    const originalStamp = new Date('2026-01-01T00:00:00.000Z');
    const successorStamp = new Date('2026-01-01T00:31:00.000Z');
    const file = await makeFile(successorStamp); // simulates the stale arm having already taken over

    const result = await fabFileRepository.confirmChunkClaim(String(file._id), originalStamp);
    expect(result).toBe(false);
  });

  it('returns false for a fabFileId that does not exist', async () => {
    const result = await fabFileRepository.confirmChunkClaim(new mongoose.Types.ObjectId().toString(), new Date());
    expect(result).toBe(false);
  });

  it('does not modify chunkClaimedAt when it matches (a true no-op write)', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    const file = await makeFile(stamp);

    await fabFileRepository.confirmChunkClaim(String(file._id), stamp);

    const reloaded = await FabFile.findById(file._id);
    expect(reloaded?.chunkClaimedAt?.toISOString()).toBe(stamp.toISOString());
  });
});
