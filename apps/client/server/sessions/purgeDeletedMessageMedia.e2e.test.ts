import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FabFile, Quest, Session, questRepository } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

const effects = vi.hoisted(() => ({ deleteGenerated: vi.fn(), enqueue: vi.fn() }));

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: effects.deleteGenerated }),
}));
vi.mock('@bike4mind/server-utils/sessions/generatedMediaPurgeQueue', () => ({
  enqueueGeneratedMediaPurge: effects.enqueue,
}));

import { purgeDeletedMessageMedia } from './purgeDeletedMessageMedia';
import { MAX_DELETES_PER_RUN } from '@bike4mind/server-utils/sessions/purgeDeletedNotebookMedia';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let database: MongoMemoryReplSet;
const collection = (name: string) => mongoose.connection.collection(mongoose.model(name).collection.name);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const tombstone = { deletedAt: new Date() };

// A key of the generated-content shape that sorts like `name`, so fixtures stay readable.
const gk = (name: string) => {
  const dot = name.lastIndexOf('.');
  const hex = Buffer.from(name.slice(0, dot)).toString('hex').padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${name.slice(dot)}`;
};

async function notebook(deleted = false, userId = 'u1') {
  const id = new mongoose.Types.ObjectId();
  await collection(Session.modelName).insertOne({ _id: id, userId, ...(deleted ? tombstone : {}) });
  return String(id);
}

async function message(sessionId: string, media: { images?: string[]; videos?: string[] }, deleted = false) {
  const { insertedId } = await collection(Quest.modelName).insertOne({
    sessionId,
    ...media,
    ...(deleted ? tombstone : {}),
  });
  return { id: String(insertedId), sessionId, ...media };
}

const deletedKeys = () => effects.deleteGenerated.mock.calls.map(([key]) => key).sort();

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
  effects.enqueue.mockResolvedValue(true);
  for (const modelName of mongoose.modelNames()) await collection(modelName).deleteMany({});
});

describe('purgeDeletedMessageMedia', () => {
  it('deletes the media only the deleted message used', async () => {
    const sessionId = await notebook();
    await message(sessionId, { images: [gk('other.png')] });
    const deleted = await message(sessionId, { images: [gk('a.png')], videos: [gk('b.mp4')] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(deletedKeys()).toEqual([gk('a.png'), gk('b.mp4')]);
    expect(effects.enqueue).toHaveBeenCalledWith({ keys: [], ownerIds: ['u1'] }, logger);
  });

  it('keeps a key another live message of the same notebook shows', async () => {
    const sessionId = await notebook();
    await message(sessionId, { images: [gk('shared.png')] });
    const deleted = await message(sessionId, { images: [gk('shared.png'), gk('own.png')] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([gk('own.png')]);
  });

  it('purges a key that only an earlier deleted message also showed', async () => {
    const sessionId = await notebook();
    await message(sessionId, { images: [gk('old.png')] }, true);
    const deleted = await message(sessionId, { images: [gk('old.png')] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([gk('old.png')]);
  });

  it('keeps a key a live fork shows, but not one only a deleted fork shows', async () => {
    const sessionId = await notebook();
    await message(await notebook(), { images: [gk('forked.png')], videos: [gk('forked.mp4')] });
    await message(await notebook(true), { images: [gk('dead-fork.png')] });
    const deleted = await message(
      sessionId,
      { images: [gk('forked.png'), gk('dead-fork.png')], videos: [gk('forked.mp4')] },
      true
    );

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([gk('dead-fork.png')]);
  });

  it('keeps a key a live library file copied, but not one a deleted file copied', async () => {
    const sessionId = await notebook();
    await collection(FabFile.modelName).insertOne({ sourceMetadata: { generatedCopyKey: gk('kept.png') } });
    await collection(FabFile.modelName).insertOne({
      sourceMetadata: { generatedCopyKey: gk('gone.png') },
      ...tombstone,
    });
    const deleted = await message(sessionId, { images: [gk('kept.png'), gk('gone.png')] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([gk('gone.png')]);
  });

  it('runs no queries and deletes nothing for a message without media', async () => {
    const findSpy = vi.spyOn(Quest, 'find');
    await purgeDeletedMessageMedia(
      { id: new mongoose.Types.ObjectId().toString(), sessionId: new mongoose.Types.ObjectId().toString() },
      { logger }
    );

    expect(findSpy).not.toHaveBeenCalled();
    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it('logs a storage failure and still purges the other keys', async () => {
    const sessionId = await notebook();
    const deleted = await message(sessionId, { images: [gk('bad.png'), gk('good.png')] }, true);
    effects.deleteGenerated.mockImplementation(async (key: string) => {
      if (key === gk('bad.png')) throw new Error('S3 down');
    });

    await expect(purgeDeletedMessageMedia(deleted, { logger })).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(gk('bad.png')));
    expect(effects.enqueue.mock.calls[0][0].keys).toEqual([gk('bad.png')]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('hands every key to the queue when the retention lookup fails', async () => {
    const sessionId = await notebook();
    const deleted = await message(sessionId, { images: [gk('a.png'), gk('b.png')] }, true);
    const find = vi.spyOn(questRepository, 'findLiveSessionIdsByMediaKeys').mockRejectedValue(new Error('Mongo down'));

    try {
      await expect(purgeDeletedMessageMedia(deleted, { logger })).resolves.toBeUndefined();
    } finally {
      find.mockRestore();
    }

    expect(effects.deleteGenerated).not.toHaveBeenCalled();
    expect(effects.enqueue.mock.calls[0][0].keys.sort()).toEqual([gk('a.png'), gk('b.png')].sort());
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error naming the keys left in storage when the hand-off to the queue fails', async () => {
    const sessionId = await notebook();
    const deleted = await message(sessionId, { images: [gk('bad.png')] }, true);
    effects.deleteGenerated.mockRejectedValue(new Error('S3 down'));
    effects.enqueue.mockResolvedValue(false);

    await expect(purgeDeletedMessageMedia(deleted, { logger })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('1 keys left in storage'));
  });

  it('never purges an imported key another user produced, nor one outside the generated-content shape', async () => {
    const [foreign, own] = [gk('theirs.png'), gk('own.png')];
    const theirs = await notebook(true, 'u2');
    await message(theirs, { images: [foreign] }, true);
    const sessionId = await notebook();
    const deleted = await message(sessionId, { images: [foreign, own, '../other/object.png', 'avatars/u2.png'] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([own]);
  });

  it('deletes an ObjectId-keyed audio file', async () => {
    const sessionId = await notebook();
    const audio = `${new mongoose.Types.ObjectId().toString()}.mp3`;
    const deleted = await message(sessionId, { images: [audio] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([audio]);
  });

  it('deletes spreadsheet keys named with spaces, punctuation and non-ASCII characters', async () => {
    const sheets = [
      'Q3 Sales Report-1a2b3c4d.xlsx',
      'P&L Statement (2026)-1a2b3c4d.xlsx',
      'Caf\u00e9 Budget-1a2b3c4d.xlsx',
    ];
    const sessionId = await notebook();
    const deleted = await message(sessionId, { images: sheets }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(deletedKeys()).toEqual([...sheets].sort());
  });

  it('deletes at most one run of keys for a message holding thousands of keys', async () => {
    const sessionId = await notebook();
    const junk = Array.from({ length: 3001 }, (_, i) => `junk/x${i}.png`);
    const imported = Array.from({ length: 1500 }, (_, i) => gk(`k${i}.png`));
    const deleted = await message(sessionId, { images: [...junk, ...imported] }, true);

    await purgeDeletedMessageMedia(deleted, { logger });

    expect(effects.enqueue.mock.calls[0][0].keys).toHaveLength(1500 - MAX_DELETES_PER_RUN);
  });
});
