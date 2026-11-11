import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FabFile, Quest, Session } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({ deleteGenerated: vi.fn(), cdnSend: vi.fn(), enqueue: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.deleteGenerated }),
}));
vi.mock('@server/sessions/generatedMediaPurgeQueue', () => ({ enqueueGeneratedMediaPurge: effects.enqueue }));
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

import { purgeDeletedMessageMedia } from './purgeDeletedMessageMedia';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let database: MongoMemoryReplSet;
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);
const logger = { info: vi.fn(), warn: vi.fn() };
const tombstone = { deletedAt: new Date() };

async function notebook(deleted = false) {
  const id = new mongoose.Types.ObjectId();
  await collection(Session.modelName).insertOne({ _id: id, userId: 'u1', ...(deleted ? tombstone : {}) });
  return String(id);
}

async function message(sessionId: string, media: { images?: string[]; videos?: string[] }, deleted = false) {
  const { insertedId } = await collection(Quest.modelName).insertOne({
    sessionId,
    ...media,
    ...(deleted ? tombstone : {}),
  });
  return { id: String(insertedId), ...media };
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
  effects.enqueue.mockResolvedValue(true);
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

describe('purgeDeletedMessageMedia', () => {
  it('deletes the media only the deleted message used and invalidates its /generated paths', async () => {
    const sessionId = await notebook();
    await message(sessionId, { images: ['other.png'] });
    const deleted = await message(sessionId, { images: ['a.png'], videos: ['b.mp4'] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(deletedKeys()).toEqual(['a.png', 'b.mp4']);
    expect(invalidatedPaths()).toEqual([['/generated/a.png', '/generated/b.mp4']]);
    expect(effects.enqueue).toHaveBeenCalledWith({ keys: [] }, logger);
  });

  it('keeps a key another live message of the same notebook shows', async () => {
    const sessionId = await notebook();
    await message(sessionId, { images: ['shared.png'] });
    const deleted = await message(sessionId, { images: ['shared.png', 'own.png'] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual(['own.png']);
  });

  it('purges a key that only an earlier deleted message also showed', async () => {
    const sessionId = await notebook();
    await message(sessionId, { images: ['old.png'] }, true);
    const deleted = await message(sessionId, { images: ['old.png'] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual(['old.png']);
  });

  it('keeps a key a live fork shows, but not one only a deleted fork shows', async () => {
    const sessionId = await notebook();
    await message(await notebook(), { images: ['forked.png'], videos: ['forked.mp4'] });
    await message(await notebook(true), { images: ['dead-fork.png'] });
    const deleted = await message(sessionId, { images: ['forked.png', 'dead-fork.png'], videos: ['forked.mp4'] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual(['dead-fork.png']);
  });

  it('keeps a key a live library file copied, but not one a deleted file copied', async () => {
    const sessionId = await notebook();
    await collection(FabFile.modelName).insertOne({ sourceMetadata: { generatedCopyKey: 'kept.png' } });
    await collection(FabFile.modelName).insertOne({ sourceMetadata: { generatedCopyKey: 'gone.png' }, ...tombstone });
    const deleted = await message(sessionId, { images: ['kept.png', 'gone.png'] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual(['gone.png']);
  });

  it('runs no queries and deletes nothing for a message without media', async () => {
    const findSpy = vi.spyOn(Quest, 'find');
    await purgeDeletedMessageMedia({ id: new mongoose.Types.ObjectId().toString() }, { logger });

    expect(findSpy).not.toHaveBeenCalled();
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    expect(effects.cdnSend).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it('logs a storage failure and still purges the other keys', async () => {
    const sessionId = await notebook();
    const deleted = await message(sessionId, { images: ['bad.png', 'good.png'] }, true);
    effects.deleteGenerated.mockImplementation(async (key: string) => {
      if (key === 'bad.png') throw new Error('S3 down');
    });

    await expect(purgeDeletedMessageMedia(deleted, { logger })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad.png'));
    expect(invalidatedPaths()).toEqual([['/generated/good.png']]);
  });
});
