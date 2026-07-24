import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

describe('QuestModel.getMostRecentChatHistory', () => {
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

  // Regression lock: the .select() projection is inclusion-mode, so any field not listed is
  // silently dropped at runtime while TS stays green. fabFileIds was missing, which made
  // ImageGenerationService.selectInputImage's notebook-attachment branch dead code. A unit
  // test that mocks getMostRecentChatHistory cannot catch this - it must hit real Mongo.
  it('returns fabFileIds so image-gen can use an image attached to an earlier turn', async () => {
    await Quest.create(makeQuest({ prompt: 'here is a reference image', fabFileIds: ['fab-1', 'fab-2'] }));

    const [msg] = await questRepository.getMostRecentChatHistory('session-1', 10);

    expect(msg).toBeDefined();
    expect(msg.fabFileIds).toEqual(['fab-1', 'fab-2']);
  });

  it('returns messages newest-first', async () => {
    await Quest.create(makeQuest({ prompt: 'older', timestamp: new Date(1_000) }));
    await Quest.create(makeQuest({ prompt: 'newer', timestamp: new Date(2_000) }));

    const history = await questRepository.getMostRecentChatHistory('session-1', 10);

    expect(history.map(m => m.prompt)).toEqual(['newer', 'older']);
  });
});
