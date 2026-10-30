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

// Guards the index the signup-grant activity aggregate reads (apps/client/server/credits/activityUnlock.ts).
// Partial so migration 20260921235966 does not index every quest in the largest collection.
describe('Quest signup activity index', () => {
  it('builds the named compound index over provenance-carrying turns only', async () => {
    await Quest.syncIndexes();
    const indexes = await Quest.collection.indexes();
    const idx = indexes.find(i => i.name === 'signupActivity_user_status_startedAt');
    expect(idx?.key).toEqual({ 'signupActivity.userId': 1, status: 1, 'signupActivity.startedAt': 1 });
    expect(idx?.partialFilterExpression).toEqual({ 'signupActivity.userId': { $exists: true } });
  });
});
