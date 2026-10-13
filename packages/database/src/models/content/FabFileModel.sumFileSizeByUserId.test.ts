import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { chargedBytes, KnowledgeType, STORAGE_CHARGE_STAMP_CUTOFF } from '@bike4mind/common';
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

const makeFile = (userId: string, fileName: string, fileSize?: number, fields: Record<string, unknown> = {}) =>
  FabFile.create({
    userId,
    fileName,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: fileName,
    status: 'complete',
    storageChargedAt: new Date(),
    ...(fileSize === undefined ? {} : { fileSize }),
    ...fields,
  });

// Drives recalculateUserStorage: sums fileSize in the DB so the admin repair action
// never hydrates a heavy user's whole file set to produce one integer.
describe('FabFileRepository.sumFileSizeByUserId', () => {
  const userId = 'u-sum';

  it('sums fileSize across a user non-deleted files', async () => {
    await makeFile(userId, 'a.txt', 100);
    await makeFile(userId, 'b.txt', 200);
    const total = await fabFileRepository.sumFileSizeByUserId(userId);
    expect(total).toBe(300);
  });

  it('counts a missing or zero fileSize as 0', async () => {
    await makeFile(userId, 'has-size.txt', 50);
    await makeFile(userId, 'no-size.txt'); // fileSize never set
    await makeFile(userId, 'zero-size.txt', 0);
    const total = await fabFileRepository.sumFileSizeByUserId(userId);
    expect(total).toBe(50);
  });

  it('excludes soft-deleted files', async () => {
    await makeFile(userId, 'live.txt', 100);
    const deleted = await makeFile(userId, 'deleted.txt', 999);
    await FabFile.updateOne({ _id: deleted._id }, { $set: { deletedAt: new Date() } });
    const total = await fabFileRepository.sumFileSizeByUserId(userId);
    expect(total).toBe(100);
  });

  it('excludes other users files', async () => {
    await makeFile(userId, 'mine.txt', 100);
    await makeFile('someone-else', 'theirs.txt', 500);
    const total = await fabFileRepository.sumFileSizeByUserId(userId);
    expect(total).toBe(100);
  });

  // Must count exactly the rows isStorageCharged counts, so recalc agrees with every refund site.
  it('counts only charged rows: stamped (any status) or legacy pre-cutoff complete', async () => {
    const before = new Date(STORAGE_CHARGE_STAMP_CUTOFF.getTime() - 1000);
    await makeFile(userId, 'stamped-complete.txt', 1);
    await makeFile(userId, 'stamped-pending.txt', 2, { status: 'pending' });
    await makeFile(userId, 'pending.txt', 4, { status: 'pending', storageChargedAt: null });
    await makeFile(userId, 'post-cutoff-unstamped.txt', 8, { storageChargedAt: null });
    const legacy = await makeFile(userId, 'legacy.txt', 16, { storageChargedAt: null });
    await FabFile.collection.updateOne({ _id: legacy._id }, { $set: { createdAt: before } });
    const legacyPending = await makeFile(userId, 'legacy-pending.txt', 32, {
      storageChargedAt: null,
      status: 'pending',
    });
    await FabFile.collection.updateOne({ _id: legacyPending._id }, { $set: { createdAt: before } });
    const atCutoff = await makeFile(userId, 'at-cutoff.txt', 64, { storageChargedAt: null });
    await FabFile.collection.updateOne({ _id: atCutoff._id }, { $set: { createdAt: STORAGE_CHARGE_STAMP_CUTOFF } });

    const total = await fabFileRepository.sumFileSizeByUserId(userId);
    expect(total).toBe(1 + 2 + 16);
    const rows = await FabFile.find({ userId }).lean();
    expect(rows.reduce((sum, row) => sum + chargedBytes(row), 0)).toBe(total);
  });

  it('returns 0 for a user with no files', async () => {
    const total = await fabFileRepository.sumFileSizeByUserId('no-such-user');
    expect(total).toBe(0);
  });
});
