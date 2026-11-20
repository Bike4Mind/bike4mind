import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest } from './QuestModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('retired Quest signupActivity', () => {
  it('stays out of default reads while a stored quest still carries it', async () => {
    const { insertedId } = await Quest.collection.insertOne({
      sessionId: 'session-1',
      type: 'chat',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      signupActivity: { userId: 'user-1', turnId: 'turn-1', startedAt: new Date('2026-01-01T00:00:00Z') },
    });

    const lean = (await Quest.findById(insertedId).lean()) as Record<string, unknown> | null;
    expect(lean).not.toBeNull();
    expect(lean).not.toHaveProperty('signupActivity');
    const doc = await Quest.findById(insertedId);
    expect(doc?.toJSON()).not.toHaveProperty('signupActivity');
  });
});
