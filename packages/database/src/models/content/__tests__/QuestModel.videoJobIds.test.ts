import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

// Mongoose strict mode silently drops a field the Zod schema allows but the model lacks, so the
// round trip through real Mongo is the only proof videoJobIds persists.
describe('QuestModel videoJobIds persistence', () => {
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
    status: 'running',
    agentExecutionId: 'exec-1',
    videoJobIds: ['a'],
    ...overrides,
  });

  it('persists videoJobIds through save and read', async () => {
    const created = await questRepository.create(makeQuest());
    const readBack = await Quest.findById(created.id).lean();
    expect(readBack?.videoJobIds).toEqual(['a']);
  });

  it('returns videoJobIds from findUnfinishedByAgentExecutionIds', async () => {
    await questRepository.create(makeQuest());
    const [view] = await questRepository.findUnfinishedByAgentExecutionIds(['exec-1']);
    expect(view.videoJobIds).toEqual(['a']);
  });

  it('returns videoJobIds from findStaleRunning', async () => {
    const created = await questRepository.create(makeQuest());
    await Quest.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $set: { updatedAt: new Date(Date.now() - 300_000) } }
    );
    const [view] = await questRepository.findStaleRunning({ olderThan: new Date(Date.now() - 120_000) });
    expect(view.videoJobIds).toEqual(['a']);
  });
});
