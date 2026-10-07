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

  it('keeps promptMeta the pipeline wrote after the caller read the quest', async () => {
    const quest = await Quest.create({
      sessionId: 'session-1',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hello',
    });
    await questRepository.update({
      id: quest.id,
      promptMeta: {
        performance: { firstChunkTime: 10, firstTokenTime: 20 },
        statusLog: [{ status: 'streaming', timestamp: new Date() }],
      },
    });

    await expect(questRepository.setClientFirstTokenTime(quest.id, 250)).resolves.toBe(true);

    const raw = await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(quest.id) });
    expect(raw?.promptMeta.performance).toMatchObject({
      firstChunkTime: 10,
      firstTokenTime: 20,
      clientFirstTokenTime: 250,
    });
    expect(raw?.promptMeta.statusLog).toHaveLength(1);
  });

  it('creates the path on a quest with no promptMeta yet', async () => {
    const quest = await Quest.create({ sessionId: 'session-1', type: 'message', timestamp: new Date(), prompt: 'hi' });

    await questRepository.setClientFirstTokenTime(quest.id, 99);

    const raw = await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(quest.id) });
    expect(raw?.promptMeta.performance.clientFirstTokenTime).toBe(99);
  });

  it('creates the path on a quest whose promptMeta is null', async () => {
    const quest = await Quest.create({ sessionId: 'session-1', type: 'message', timestamp: new Date(), prompt: 'hi' });
    await Quest.collection.updateOne({ _id: new mongoose.Types.ObjectId(quest.id) }, { $set: { promptMeta: null } });

    await expect(questRepository.setClientFirstTokenTime(quest.id, 42)).resolves.toBe(true);

    const raw = await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(quest.id) });
    expect(raw?.promptMeta.performance.clientFirstTokenTime).toBe(42);
  });

  it('reports no match for an unknown quest', async () => {
    await expect(questRepository.setClientFirstTokenTime(new mongoose.Types.ObjectId().toString(), 1)).resolves.toBe(
      false
    );
  });
});
