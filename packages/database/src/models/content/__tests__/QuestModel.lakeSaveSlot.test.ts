import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

// Real Mongo: the per-turn cap only holds if the conditional $inc is atomic and lakeSaveCount
// survives Mongoose strict mode.
describe('QuestModel.claimLakeSaveSlot', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const createQuest = () =>
    questRepository.create({
      sessionId: 'session-a',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hello',
      status: 'running',
    });

  it('grants exactly `limit` saves to concurrent claimers and persists the count', async () => {
    const quest = await createQuest();

    const results = await Promise.all(Array.from({ length: 7 }, () => questRepository.claimLakeSaveSlot(quest.id, 5)));

    expect(results.filter(Boolean)).toHaveLength(5);
    const stored = await Quest.findById(quest.id).lean();
    expect(stored?.lakeSaveCount).toBe(5);
  });

  it('refuses once the cap is reached', async () => {
    const quest = await createQuest();
    await Quest.updateOne({ _id: quest.id }, { $set: { lakeSaveCount: 5 } });

    expect(await questRepository.claimLakeSaveSlot(quest.id, 5)).toBe(false);
  });

  it('refuses when no quest matches', async () => {
    expect(await questRepository.claimLakeSaveSlot(new mongoose.Types.ObjectId().toString(), 5)).toBe(false);
  });
});
