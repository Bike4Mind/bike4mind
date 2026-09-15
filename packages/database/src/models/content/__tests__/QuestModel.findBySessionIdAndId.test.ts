import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

describe('QuestModel.findBySessionIdAndId', () => {
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
    sessionId: 'session-a',
    type: 'message',
    timestamp: new Date(),
    prompt: 'hello',
    ...overrides,
  });

  // Regression lock for the fork/snip session-binding fix: every existing caller-side test
  // (fork.test.ts, snip.test.ts) mocks this method, so none of them can catch a future change
  // to the method itself that stops filtering by sessionId. This is the one test that actually
  // exercises the real query against real Mongo.
  it('returns the message when it belongs to the given session', async () => {
    const message = await questRepository.create(makeQuest({ sessionId: 'session-a' }));

    const result = await questRepository.findBySessionIdAndId('session-a', message.id);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(message.id);
  });

  it('returns null when the message belongs to a different session', async () => {
    const message = await questRepository.create(makeQuest({ sessionId: 'session-b' }));

    const result = await questRepository.findBySessionIdAndId('session-a', message.id);

    expect(result).toBeNull();
  });

  it('returns null for a message id that does not exist at all', async () => {
    const result = await questRepository.findBySessionIdAndId('session-a', new mongoose.Types.ObjectId().toString());

    expect(result).toBeNull();
  });
});
