import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

// Mongoose strict mode silently drops a field the Zod schema allows but the model lacks, so the
// round trip through real Mongo is the only proof generationJobs persists.
describe('QuestModel generationJobs persistence', () => {
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
    generationJobs: [{ id: 'a', kind: 'video' }],
    ...overrides,
  });

  it('persists generationJobs through save and read', async () => {
    const created = await questRepository.create(makeQuest());
    const readBack = await Quest.findById(created.id).lean();
    expect(readBack?.generationJobs).toEqual([{ id: 'a', kind: 'video' }]);
  });

  it('keeps legacy videoJobIds readable', async () => {
    const created = await questRepository.create(makeQuest({ generationJobs: undefined, videoJobIds: ['v'] }));
    const readBack = await Quest.findById(created.id).lean();
    expect(readBack?.videoJobIds).toEqual(['v']);
  });

  it('addGenerationJobs appends atomically and dedups a replayed job', async () => {
    const created = await questRepository.create(makeQuest());
    await questRepository.addGenerationJobs(created.id, [{ id: 'b', kind: 'music' }]);
    await questRepository.addGenerationJobs(created.id, [
      { id: 'b', kind: 'music' },
      { id: 'a', kind: 'video' },
    ]);
    const readBack = await Quest.findById(created.id).lean();
    expect(readBack?.generationJobs).toEqual([
      { id: 'a', kind: 'video' },
      { id: 'b', kind: 'music' },
    ]);
  });

  it('addGenerationJobs creates the array on a quest that has none', async () => {
    const created = await questRepository.create(makeQuest({ generationJobs: undefined }));
    await questRepository.addGenerationJobs(created.id, [{ id: 'a', kind: 'music' }]);
    const readBack = await Quest.findById(created.id).lean();
    expect(readBack?.generationJobs).toEqual([{ id: 'a', kind: 'music' }]);
  });

  it('returns generationJobs and videoJobIds from findUnfinishedByAgentExecutionIds', async () => {
    await questRepository.create(makeQuest({ videoJobIds: ['v'] }));
    const [view] = await questRepository.findUnfinishedByAgentExecutionIds(['exec-1']);
    expect(view.generationJobs).toEqual([{ id: 'a', kind: 'video' }]);
    expect(view.videoJobIds).toEqual(['v']);
  });

  it('returns generationJobs and videoJobIds from findStaleRunning', async () => {
    const created = await questRepository.create(makeQuest({ videoJobIds: ['v'] }));
    await Quest.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $set: { updatedAt: new Date(Date.now() - 300_000) } }
    );
    const [view] = await questRepository.findStaleRunning({ olderThan: new Date(Date.now() - 120_000) });
    expect(view.generationJobs).toEqual([{ id: 'a', kind: 'video' }]);
    expect(view.videoJobIds).toEqual(['v']);
  });
});
