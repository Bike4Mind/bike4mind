import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('getMostRecentChatHistory', () => {
  it('returns generationJobs so the recent-images note can see job-made images', async () => {
    const sessionId = new mongoose.Types.ObjectId().toString();
    await Quest.collection.insertOne({
      sessionId,
      userId: 'u1',
      timestamp: new Date(),
      prompts: ['draw a cat'],
      generationJobs: [{ id: 'job-1', kind: 'image' }],
    });

    const [item] = await questRepository.getMostRecentChatHistory(sessionId, 10);

    expect(item.generationJobs).toEqual([{ id: 'job-1', kind: 'image' }]);
  });
});
