import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FabFile, Quest, Session } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({ deleteGenerated: vi.fn(), cdnSend: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.deleteGenerated }),
}));
vi.mock('@aws-sdk/client-cloudfront', () => ({
  CloudFrontClient: class {
    send = effects.cdnSend;
  },
  CreateInvalidationCommand: class {
    constructor(public input: { InvalidationBatch: { Paths: { Items: string[] } } }) {}
  },
}));
vi.mock('@bike4mind/server-utils/security/wafSharedHelpers', () => ({
  resolveRouterDistributionId: () => 'E1A2B3C4D5E6F',
}));

import { PURGE_BUDGET_MS, purgeDeletedNotebookMedia } from './purgeDeletedNotebookMedia';

let database: MongoMemoryReplSet;
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);
const logger = { info: vi.fn(), warn: vi.fn() };
const tombstone = { deletedAt: new Date() };

async function notebook(media: { images?: string[] | null; videos?: string[] | null }, deleted = true) {
  const id = new mongoose.Types.ObjectId();
  await collection(Session.modelName).insertOne({ _id: id, userId: 'u1', ...(deleted ? tombstone : {}) });
  await collection(Quest.modelName).insertOne({ sessionId: String(id), ...media, ...(deleted ? tombstone : {}) });
  return String(id);
}

const deletedKeys = () => effects.deleteGenerated.mock.calls.map(([key]) => key).sort();
const invalidatedPaths = () =>
  effects.cdnSend.mock.calls.map(([cmd]) => [...cmd.input.InvalidationBatch.Paths.Items].sort());

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  effects.deleteGenerated.mockResolvedValue(undefined);
  effects.cdnSend.mockResolvedValue({});
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

describe('purgeDeletedNotebookMedia', () => {
  it('deletes images and videos only the deleted notebook used, in one invalidation', async () => {
    const id = await notebook({ images: ['a.png', 'b.png'], videos: ['c.mp4'] });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(deletedKeys()).toEqual(['a.png', 'b.png', 'c.mp4']);
    expect(invalidatedPaths()).toEqual([['/generated/a.png', '/generated/b.png', '/generated/c.mp4']]);
  });

  it('keeps a key a live fork still shows, but not one only a deleted fork shows', async () => {
    const id = await notebook({ images: ['shared.png', 'dead-fork.png'], videos: ['shared.mp4'] });
    await notebook({ images: ['shared.png'], videos: ['shared.mp4'] }, false);
    await notebook({ images: ['dead-fork.png'] });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(deletedKeys()).toEqual(['dead-fork.png']);
  });

  it('keeps a key a live library file copied, but not one a deleted file copied', async () => {
    const id = await notebook({ images: ['kept.png', 'gone.png'] });
    await collection(FabFile.modelName).insertOne({ sourceMetadata: { generatedCopyKey: 'kept.png' } });
    await collection(FabFile.modelName).insertOne({ sourceMetadata: { generatedCopyKey: 'gone.png' }, ...tombstone });
    await purgeDeletedNotebookMedia([id], { logger });
    expect(deletedKeys()).toEqual(['gone.png']);
  });

  it('deletes a key shared only by notebooks deleted in the same call once', async () => {
    const first = await notebook({ images: ['both.png'] });
    const second = await notebook({ images: ['both.png'] });
    await purgeDeletedNotebookMedia([first, second], { logger });
    expect(deletedKeys()).toEqual(['both.png']);
    expect(invalidatedPaths()).toEqual([['/generated/both.png']]);
  });

  it('stops starting deletes once the time budget is spent and still invalidates what it deleted', async () => {
    const id = await notebook({ images: Array.from({ length: 40 }, (_, i) => `k${i}.png`) });
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    effects.deleteGenerated.mockImplementationOnce(async () => {
      now.mockReturnValue(start + PURGE_BUDGET_MS + 1);
    });
    try {
      await purgeDeletedNotebookMedia([id], { logger });
    } finally {
      now.mockRestore();
    }
    const deleted = deletedKeys();
    expect(deleted.length).toBeLessThan(40);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Time budget spent'));
    expect(invalidatedPaths()).toEqual([deleted.map(key => `/generated/${key}`).sort()]);
  });

  it('does nothing for notebooks without generated media', async () => {
    const id = await notebook({ images: null, videos: [] });
    await purgeDeletedNotebookMedia([id], { logger });
    await purgeDeletedNotebookMedia([], { logger });
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    expect(effects.cdnSend).not.toHaveBeenCalled();
  });

  it('logs a storage or CloudFront failure and still purges the other keys', async () => {
    const id = await notebook({ images: ['fails.png', 'ok.png'] });
    effects.deleteGenerated.mockImplementation(async (key: string) => {
      if (key === 'fails.png') throw new Error('s3 down');
    });
    effects.cdnSend.mockRejectedValue(new Error('throttled'));
    await expect(purgeDeletedNotebookMedia([id], { logger })).resolves.toBeUndefined();
    expect(invalidatedPaths()).toEqual([['/generated/ok.png']]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('s3 down'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('throttled'));
  });
});
