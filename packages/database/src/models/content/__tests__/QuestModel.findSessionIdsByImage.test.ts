import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

describe('QuestModel.findSessionIdsByImage', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await Quest.createIndexes();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const makeQuest = (overrides: Record<string, unknown> = {}) => ({
    sessionId: 'session-1',
    type: 'message',
    timestamp: new Date(),
    prompt: 'hello',
    ...overrides,
  });

  const KEY = '9db8f846-08d5-47d7-9166-a039d3c3d4d7.png';

  it('returns the session of a quest whose images array contains the key', async () => {
    await Quest.create(makeQuest({ sessionId: 'owner-session', images: [KEY, 'other.png'] }));

    expect(await questRepository.findSessionIdsByImage(KEY)).toEqual(['owner-session']);
  });

  it('returns [] for a key no quest references', async () => {
    await Quest.create(makeQuest({ images: ['unrelated.png'] }));

    expect(await questRepository.findSessionIdsByImage(KEY)).toEqual([]);
  });

  it('deduplicates when several quests in one session reference the key', async () => {
    await Quest.create(makeQuest({ sessionId: 's1', images: [KEY] }));
    await Quest.create(makeQuest({ sessionId: 's1', images: [KEY] }));

    expect(await questRepository.findSessionIdsByImage(KEY)).toEqual(['s1']);
  });

  it('still finds a key referenced by a soft-deleted quest', async () => {
    await Quest.create(makeQuest({ sessionId: 'deleted-session', images: [KEY], deletedAt: new Date() }));

    expect(await questRepository.findSessionIdsByImage(KEY)).toEqual(['deleted-session']);
  });
});
