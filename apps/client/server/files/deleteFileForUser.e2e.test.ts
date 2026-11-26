import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, User } from '@bike4mind/database';
import defineAbilitiesFor from '@bike4mind/server-utils/auth/ability';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// A stored object is removed only once the transaction that deletes its row commits: a later write that aborts it
// must leave both the row and the bytes. Runs against a replica set, with an in-memory object store.

const h = vi.hoisted(() => ({ stored: new Set<string>(), logEventFails: false }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({
    delete: async (key: string) => {
      h.stored.delete(key);
    },
  }),
}));
vi.mock('@bike4mind/server-utils/files/generatedCopyStore', () => ({ getGeneratedCopyStore: () => undefined }));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: async () => {
    if (h.logEventFails) throw new Error('logEvent failed');
  },
}));

import { deleteFileForUser } from './deleteFileForUser';
import { bulkDeleteFilesForUser } from './bulkDeleteFilesForUser';

let replSet: Awaited<ReturnType<typeof createMongoReplSet>> | undefined;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
afterEach(async () => {
  h.logEventFails = false;
  h.stored.clear();
  await mongoose.connection.dropDatabase();
});

const seed = async () => {
  const user = await User.create({
    name: 'owner',
    username: `owner-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
  });
  const file = await FabFile.create({
    userId: user.id,
    fileName: 'a.txt',
    type: KnowledgeType.FILE,
    mimeType: 'text/plain',
    filePath: 'uploads/a.txt',
  });
  h.stored.add('uploads/a.txt');
  const req = {
    user,
    ability: defineAbilitiesFor(user),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
  } as never;
  return { req, fileId: file.id as string };
};
const isLive = async (id: string) =>
  (await FabFile.collection.countDocuments({ _id: new mongoose.Types.ObjectId(id), deletedAt: null })) === 1;

describe('deleteFileForUser', () => {
  it('keeps the row and its object when the transaction aborts', async () => {
    const { req, fileId } = await seed();
    h.logEventFails = true;

    await expect(deleteFileForUser(req, fileId)).rejects.toThrow('logEvent failed');

    expect(await isLive(fileId)).toBe(true);
    expect(h.stored.has('uploads/a.txt')).toBe(true);
  });

  it('removes the object once the transaction commits', async () => {
    const { req, fileId } = await seed();

    await deleteFileForUser(req, fileId);

    expect(await isLive(fileId)).toBe(false);
    expect(h.stored.has('uploads/a.txt')).toBe(false);
  });
});

describe('bulkDeleteFilesForUser', () => {
  it('keeps the row and its object when the file transaction aborts', async () => {
    const { req, fileId } = await seed();
    h.logEventFails = true;

    const result = await bulkDeleteFilesForUser(req, [fileId]);

    expect(result.failed).toEqual([expect.objectContaining({ id: fileId })]);
    expect(await isLive(fileId)).toBe(true);
    expect(h.stored.has('uploads/a.txt')).toBe(true);
  });

  it('removes the object once the file transaction commits', async () => {
    const { req, fileId } = await seed();

    const result = await bulkDeleteFilesForUser(req, [fileId]);

    expect(result.deleted).toEqual([fileId]);
    expect(await isLive(fileId)).toBe(false);
    expect(h.stored.has('uploads/a.txt')).toBe(false);
  });
});
