import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

// Real Mongo: the cap only holds if the conditional $inc is atomic and the counter path survives
// Mongoose strict mode.
describe('QuestModel agent video clip slots', () => {
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

  it('grants exactly `limit` slots, even to concurrent claimers', async () => {
    const quest = await createQuest();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => questRepository.claimAgentVideoClip(quest.id, 2))
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    const readBack = await Quest.findById(quest.id).lean();
    expect(readBack?.agentVideoClipsClaimed).toBe(2);
  });

  it('a released slot can be claimed again', async () => {
    const quest = await createQuest();
    expect(await questRepository.claimAgentVideoClip(quest.id, 1)).toBe(true);
    expect(await questRepository.claimAgentVideoClip(quest.id, 1)).toBe(false);
    await questRepository.releaseAgentVideoClip(quest.id);
    expect(await questRepository.claimAgentVideoClip(quest.id, 1)).toBe(true);
  });

  it('never claims with a limit of 0', async () => {
    const quest = await createQuest();
    expect(await questRepository.claimAgentVideoClip(quest.id, 0)).toBe(false);
  });

  it('release never takes the counter below zero', async () => {
    const quest = await createQuest();
    await questRepository.releaseAgentVideoClip(quest.id);
    expect(await questRepository.claimAgentVideoClip(quest.id, 1)).toBe(true);
    const readBack = await Quest.findById(quest.id).lean();
    expect(readBack?.agentVideoClipsClaimed).toBe(1);
  });

  it('claims nothing when no Quest matches', async () => {
    expect(await questRepository.claimAgentVideoClip(new mongoose.Types.ObjectId().toString(), 2)).toBe(false);
  });
});
