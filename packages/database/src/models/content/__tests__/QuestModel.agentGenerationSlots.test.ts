import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { GENERATION_JOB_KINDS } from '@bike4mind/common';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

const counterField = { video: 'agentVideoClipsClaimed', music: 'agentMusicTracksClaimed' } as const;

// Real Mongo: the cap only holds if the conditional $inc is atomic and the counter path survives
// Mongoose strict mode.
describe('QuestModel agent generation slots', () => {
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

  describe.each(GENERATION_JOB_KINDS)('%s', kind => {
    it('grants exactly `limit` slots, even to concurrent claimers', async () => {
      const quest = await createQuest();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => questRepository.claimAgentGenerationSlot(quest.id, kind, 2))
      );
      expect(results.filter(Boolean)).toHaveLength(2);
      const readBack = await Quest.findById(quest.id).lean();
      expect(readBack?.[counterField[kind]]).toBe(2);
    });

    it('a released slot can be claimed again', async () => {
      const quest = await createQuest();
      expect(await questRepository.claimAgentGenerationSlot(quest.id, kind, 1)).toBe(true);
      expect(await questRepository.claimAgentGenerationSlot(quest.id, kind, 1)).toBe(false);
      await questRepository.releaseAgentGenerationSlot(quest.id, kind);
      expect(await questRepository.claimAgentGenerationSlot(quest.id, kind, 1)).toBe(true);
    });

    it('never claims with a limit of 0', async () => {
      const quest = await createQuest();
      expect(await questRepository.claimAgentGenerationSlot(quest.id, kind, 0)).toBe(false);
    });

    it('release never takes the counter below zero', async () => {
      const quest = await createQuest();
      await questRepository.releaseAgentGenerationSlot(quest.id, kind);
      expect(await questRepository.claimAgentGenerationSlot(quest.id, kind, 1)).toBe(true);
      const readBack = await Quest.findById(quest.id).lean();
      expect(readBack?.[counterField[kind]]).toBe(1);
    });

    it('claims nothing when no Quest matches', async () => {
      expect(await questRepository.claimAgentGenerationSlot(new mongoose.Types.ObjectId().toString(), kind, 2)).toBe(
        false
      );
    });
  });

  it('counts each kind against its own cap', async () => {
    const quest = await createQuest();
    expect(await questRepository.claimAgentGenerationSlot(quest.id, 'video', 1)).toBe(true);
    expect(await questRepository.claimAgentGenerationSlot(quest.id, 'music', 1)).toBe(true);
    expect(await questRepository.claimAgentGenerationSlot(quest.id, 'video', 1)).toBe(false);
    expect(await questRepository.claimAgentGenerationSlot(quest.id, 'music', 1)).toBe(false);
  });
});
