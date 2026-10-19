import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

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
  await Quest.collection.deleteMany({});
});

const seed = (over: Record<string, unknown> = {}) =>
  Quest.create({ sessionId: 'session-1', type: 'chat', timestamp: new Date(), ...over });

describe('questRepository.findGeneratedMediaKeysInSession', () => {
  it('matches keys referenced through images and through videos', async () => {
    await seed({ images: ['a.png', 'other.png'], videos: ['clip.mp4'] });

    const found = await questRepository.findGeneratedMediaKeysInSession('session-1', ['a.png', 'clip.mp4']);

    expect(found.sort()).toEqual(['a.png', 'clip.mp4']);
  });

  it('returns only requested keys, not every key on a matching quest', async () => {
    await seed({ images: ['a.png', 'unrequested.png'] });

    expect(await questRepository.findGeneratedMediaKeysInSession('session-1', ['a.png'])).toEqual(['a.png']);
  });

  it('ignores keys referenced only by another session', async () => {
    await seed({ sessionId: 'session-2', images: ['a.png'] });

    expect(await questRepository.findGeneratedMediaKeysInSession('session-1', ['a.png'])).toEqual([]);
  });

  it('ignores keys that only a soft-deleted quest references', async () => {
    await seed({ images: ['gone.png'], deletedAt: new Date() });
    await seed({ images: ['kept.png'] });

    expect(await questRepository.findGeneratedMediaKeysInSession('session-1', ['gone.png', 'kept.png'])).toEqual([
      'kept.png',
    ]);
  });

  it('returns [] for an empty key list or session id', async () => {
    await seed({ images: ['a.png'] });

    expect(await questRepository.findGeneratedMediaKeysInSession('session-1', [])).toEqual([]);
    expect(await questRepository.findGeneratedMediaKeysInSession('', ['a.png'])).toEqual([]);
  });

  it('de-duplicates a key referenced by several quests and by both fields', async () => {
    await seed({ images: ['a.png'] });
    await seed({ images: ['a.png'], videos: ['a.png'] });

    expect(await questRepository.findGeneratedMediaKeysInSession('session-1', ['a.png'])).toEqual(['a.png']);
  });
});
