import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { Quest, questRepository } from '../QuestModel';

describe('questRepository.setClientFirstTokenTime', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const createQuest = () =>
    Quest.create({ sessionId: 'session-1', type: 'message', timestamp: new Date(), prompt: 'hello' });

  const readRaw = (id: string) => Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

  it('survives a later whole-quest save from a copy read before it was posted', async () => {
    const quest = await createQuest();
    const pipelineCopy = await questRepository.findById(quest.id);

    await expect(questRepository.setClientFirstTokenTime(quest.id, 250)).resolves.toBe(true);

    await questRepository.update({
      ...pipelineCopy!,
      promptMeta: {
        ...pipelineCopy!.promptMeta,
        performance: { firstChunkTime: 10, firstTokenTime: 20, totalResponseTime: 900 },
        statusLog: [{ status: 'done', timestamp: new Date() }],
      },
    });

    const raw = await readRaw(quest.id);
    expect(raw?.clientFirstTokenTime).toBe(250);
    expect(raw?.promptMeta.performance).toMatchObject({ firstChunkTime: 10, firstTokenTime: 20, totalResponseTime: 900 });
  });

  it('leaves promptMeta the pipeline already wrote untouched', async () => {
    const quest = await createQuest();
    await questRepository.update({
      id: quest.id,
      promptMeta: {
        performance: { firstChunkTime: 10, firstTokenTime: 20 },
        statusLog: [{ status: 'streaming', timestamp: new Date() }],
      },
    });

    await questRepository.setClientFirstTokenTime(quest.id, 250);

    const raw = await readRaw(quest.id);
    expect(raw?.clientFirstTokenTime).toBe(250);
    expect(raw?.promptMeta.performance).toMatchObject({ firstChunkTime: 10, firstTokenTime: 20 });
    expect(raw?.promptMeta.statusLog).toHaveLength(1);
  });

  it('writes on a quest whose promptMeta is null', async () => {
    const quest = await createQuest();
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(quest.id) }, { $set: { promptMeta: null } });

    await expect(questRepository.setClientFirstTokenTime(quest.id, 42)).resolves.toBe(true);

    const raw = await readRaw(quest.id);
    expect(raw?.clientFirstTokenTime).toBe(42);
    expect(raw?.promptMeta).toBeNull();
  });

  it('reports no match for an unknown quest', async () => {
    await expect(questRepository.setClientFirstTokenTime(new mongoose.Types.ObjectId().toString(), 1)).resolves.toBe(
      false
    );
  });
});
