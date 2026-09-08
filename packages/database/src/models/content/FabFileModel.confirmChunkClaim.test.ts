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

  it('leaves chunkClaimedAt intact but always re-stamps chunkClaimConfirmedAt (never a no-op write)', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    const file = await makeFile(stamp);
    expect(file.chunkClaimConfirmedAt).toBeNull();

    await fabFileRepository.confirmChunkClaim(String(file._id), stamp);
    const firstReload = await FabFile.findById(file._id);

    // The release CAS in fabFileChunk.ts matches on this run's original stamp, so it must not move.
    expect(firstReload?.chunkClaimedAt?.toISOString()).toBe(stamp.toISOString());
    // ...but the update must still be a genuine write, or MongoDB may elide the self-valued $set on
    // chunkClaimedAt and a concurrent takeover inside the snapshot window goes undetected - see
    // confirmChunkClaim's doc comment. chunkClaimConfirmedAt exists solely to guarantee that.
    expect(firstReload?.chunkClaimConfirmedAt).toBeInstanceOf(Date);

    // A second call proves it is re-stamped every time, not just set once from null.
    await new Promise(resolve => setTimeout(resolve, 5));
    await fabFileRepository.confirmChunkClaim(String(file._id), stamp);
    const secondReload = await FabFile.findById(file._id);
    expect(secondReload!.chunkClaimConfirmedAt!.getTime()).toBeGreaterThan(
      firstReload!.chunkClaimConfirmedAt!.getTime()
    );
  });
});
