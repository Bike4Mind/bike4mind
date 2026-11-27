import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { FabFile, Quest, Session } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('../utils/storage/index', () => ({ getGeneratedImageStorage: () => ({ delete: vi.fn() }) }));
vi.mock('./generatedMediaPurgeQueue', () => ({ enqueueGeneratedMediaPurge: vi.fn() }));

import { findImportableMediaKeys } from './findImportableMediaKeys';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);

async function notebookWithImages(userId: string, images: string[], createdAt: Date) {
  const id = new mongoose.Types.ObjectId();
  await collection(Session.modelName).insertOne({ _id: id, userId });
  await collection(Quest.modelName).insertOne({ sessionId: String(id), images, createdAt });
}

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

describe('findImportableMediaKeys', () => {
  it("keeps keys first produced in the user's own notebooks", async () => {
    await notebookWithImages('me', ['mine.png'], new Date('2025-01-01'));
    expect(await findImportableMediaKeys(['mine.png'], 'me')).toEqual(new Set(['mine.png']));
  });

  it("drops a key first produced in another user's notebook, even if the user later copied it", async () => {
    await notebookWithImages('other', ['theirs.png'], new Date('2025-01-01'));
    await notebookWithImages('me', ['theirs.png'], new Date('2025-02-01'));
    expect(await findImportableMediaKeys(['theirs.png'], 'me')).toEqual(new Set());
  });

  it('drops a key no message references', async () => {
    expect(await findImportableMediaKeys(['nowhere.mp3', 'folder/x/y.png'], 'me')).toEqual(new Set());
  });

  it("keeps the user's own uploaded file and drops another user's", async () => {
    await collection(FabFile.modelName).insertMany([
      { userId: 'me', filePath: 'uploads/me/a.png' },
      { userId: 'other', filePath: 'uploads/other/b.png' },
    ]);
    expect(await findImportableMediaKeys(['uploads/me/a.png', 'uploads/other/b.png'], 'me')).toEqual(
      new Set(['uploads/me/a.png'])
    );
  });

  it('ignores non-string and empty entries from untrusted input', async () => {
    expect(await findImportableMediaKeys([null, 7, ''] as unknown as string[], 'me')).toEqual(new Set());
  });
});
