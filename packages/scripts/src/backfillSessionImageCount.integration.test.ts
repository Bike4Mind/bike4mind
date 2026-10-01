import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Quest, Session } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { backfillSessionImageCounts } from './backfillSessionImageCount';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
  await Session.collection.deleteMany({});
  await Quest.collection.deleteMany({});
});

const silent = () => undefined;

const session = async (name: string) => {
  const doc = await Session.create({ name, userId: 'u1', lastUpdated: new Date(), firstCreated: new Date() });
  // Rows that predate the field carry no imageCount at all.
  await Session.collection.updateOne({ _id: doc._id }, { $unset: { imageCount: '' } });
  return doc.id as string;
};

const quest = (sessionId: string, images: string[], extra: Record<string, unknown> = {}) =>
  Quest.collection.insertOne({ sessionId, type: 'message', prompt: 'p', timestamp: new Date(), images, ...extra });

const countOf = async (id: string) =>
  (await Session.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }))?.imageCount;

describe('backfillSessionImageCounts', () => {
  it('sums images per session and leaves image-free sessions alone', async () => {
    const withImages = await session('images');
    const withoutImages = await session('chat');
    await quest(withImages, ['a.png', 'b.png']);
    await quest(withImages, ['c.png']);
    await quest(withImages, []);
    await quest(withoutImages, []);

    const result = await backfillSessionImageCounts({ dryRun: false, log: silent });

    expect(result).toEqual({ sessionsWithImages: 1, updated: 1 });
    expect(await countOf(withImages)).toBe(3);
    expect(await countOf(withoutImages)).toBeUndefined();
  });

  it('counts only image entries when quests also carry audio and spreadsheet output', async () => {
    const mixed = await session('mixed');
    const noImages = await session('audio-and-sheets');
    await quest(mixed, ['a.png', 'track.mp3', 'b.JPEG', 'report.xlsx', 'c.webp?sig=1']);
    await quest(mixed, ['d.svg', 'voice.wav']);
    await quest(noImages, ['song.mp3', 'data.xlsx', 'notes.pdf']);

    const result = await backfillSessionImageCounts({ dryRun: false, log: silent });

    // c.webp?sig=1 does not end in an image extension, so the UI would not render it inline either.
    expect(result).toEqual({ sessionsWithImages: 1, updated: 1 });
    expect(await countOf(mixed)).toBe(3);
    expect(await countOf(noImages)).toBeUndefined();
  });

  it('skips soft-deleted quests', async () => {
    const id = await session('s');
    await quest(id, ['a.png']);
    await quest(id, ['gone.png'], { deletedAt: new Date() });

    await backfillSessionImageCounts({ dryRun: false, log: silent });

    expect(await countOf(id)).toBe(1);
  });

  it('writes nothing in a dry run but reports what it would update', async () => {
    const id = await session('s');
    await quest(id, ['a.png']);

    const result = await backfillSessionImageCounts({ dryRun: true, log: silent });

    expect(result.updated).toBe(1);
    expect(await countOf(id)).toBeUndefined();
  });

  it('is idempotent and never lowers a counter the app already moved', async () => {
    const id = await session('s');
    await quest(id, ['a.png']);
    await Session.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { imageCount: 5 } });

    const first = await backfillSessionImageCounts({ dryRun: false, log: silent });
    const second = await backfillSessionImageCounts({ dryRun: false, log: silent });

    expect(first.updated).toBe(0);
    expect(second.updated).toBe(0);
    expect(await countOf(id)).toBe(5);
  });

  it('batches across multiple bulk writes', async () => {
    const ids = await Promise.all(['a', 'b', 'c'].map(session));
    await Promise.all(ids.map(id => quest(id, ['x.png'])));

    const result = await backfillSessionImageCounts({ dryRun: false, batchSize: 2, log: silent });

    expect(result).toEqual({ sessionsWithImages: 3, updated: 3 });
    for (const id of ids) expect(await countOf(id)).toBe(1);
  });
});
