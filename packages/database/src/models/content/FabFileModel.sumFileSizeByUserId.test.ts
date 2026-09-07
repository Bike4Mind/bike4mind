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

const makeFile = (userId: string, fileName: string, fileSize?: number) =>
  FabFile.create({
    userId,
    fileName,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: fileName,
    ...(fileSize === undefined ? {} : { fileSize }),
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

  it('returns 0 for a user with no files', async () => {
    const total = await fabFileRepository.sumFileSizeByUserId('no-such-user');
    expect(total).toBe(0);
  });
});
