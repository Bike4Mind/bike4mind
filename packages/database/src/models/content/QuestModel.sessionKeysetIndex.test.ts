import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest } from './QuestModel';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await Quest.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// Guards the index findPageAfterBySessionId range-scans. The plan that index produces is
// pinned separately in QuestModel.sessionKeyset.test.ts; this file guards its shape.
describe('Quest sessionId+timestamp+_id index', () => {
  it('builds the named compound index', async () => {
    const indexes = await Quest.collection.indexes();
    expect(indexes.find(i => i.name === 'sessionId_timestamp_id')?.key).toEqual({
      sessionId: 1,
      timestamp: 1,
      _id: 1,
    });
  });

  it('does not duplicate an existing index key pattern', async () => {
    const built = (await Quest.collection.indexes()).map(i => JSON.stringify(i.key));
    expect(new Set(built).size).toBe(built.length);
    const declared = Quest.schema.indexes().map(([key]) => JSON.stringify(key));
    expect(new Set(declared).size).toBe(declared.length);
  });
});
