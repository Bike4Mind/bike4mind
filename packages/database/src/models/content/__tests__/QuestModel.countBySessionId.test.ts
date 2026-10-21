import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

describe('QuestModel.countBySessionId', () => {
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

  it('counts the live quests of one session, including the in-flight one', async () => {
    await Quest.create([makeQuest(), makeQuest(), makeQuest()]);
    await Quest.create(makeQuest({ sessionId: 'session-2' }));

    expect(await questRepository.countBySessionId('session-1')).toBe(3);
    expect(await questRepository.countBySessionId('session-2')).toBe(1);
    expect(await questRepository.countBySessionId('nobody')).toBe(0);
  });

  // The window math reads this against getMostRecentChatHistory, which filters deletedAt itself.
  it('does not count soft-deleted quests', async () => {
    await Quest.create([makeQuest(), makeQuest(), makeQuest({ deletedAt: new Date() })]);

    expect(await questRepository.countBySessionId('session-1')).toBe(2);
  });

  // Runs per turn on a long session, so it must be an index-only count rather than a collection or
  // document scan.
  it('is answered from an index without fetching documents', async () => {
    await Quest.create([makeQuest(), makeQuest()]);

    const plan = await Quest.aggregate([
      { $match: { sessionId: 'session-1', deletedAt: null } },
      { $group: { _id: null, n: { $sum: 1 } } },
    ]).explain('queryPlanner');

    // The planner reaches for the {deletedAt, sessionId, timestamp} index: equality on the first two
    // keys is a COUNT_SCAN over index keys alone.
    const stages = JSON.stringify(plan);
    expect(stages).toContain('"stage":"COUNT_SCAN"');
    expect(stages).toContain('"indexName":"deletedAt_sessionId_timestamp_desc"');
    expect(stages).not.toContain('COLLSCAN');
    expect(stages).not.toContain('"stage":"FETCH"');
  });
});
