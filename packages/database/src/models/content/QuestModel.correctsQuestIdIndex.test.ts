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

// Guards the index the correction-chain walk reads. Dense rather than sparse or partial:
// sparse keys off the leading field (sessionId, present on every quest) and DocumentDB
// rejects most partial filters (see models/DOCUMENTDB_COMPATIBILITY_NOTES.md).
describe('Quest sessionId+correctsQuestId index', () => {
  it('builds the named compound index, dense and non-unique', async () => {
    await expect(Quest.syncIndexes()).resolves.toBeDefined();
    const indexes = await Quest.collection.indexes();
    const idx = indexes.find(i => i.name === 'sessionId_correctsQuestId');
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ sessionId: 1, correctsQuestId: 1 });
    expect(idx?.sparse).toBeFalsy();
    expect(idx?.partialFilterExpression).toBeUndefined();
    expect(idx?.unique).toBeFalsy();
  });

  // The index existing is not the claim worth guarding - several existing indexes lead on
  // sessionId, so the planner could serve this query without it and leave the test above green.
  it('is the index the correction-link query is planned onto', async () => {
    await Quest.syncIndexes();
    for (let i = 0; i < 60; i++) {
      await Quest.create({
        sessionId: 'plan-1',
        type: 'chat',
        timestamp: new Date(),
        correctsQuestId: i % 2 ? 'x' : null,
      });
    }

    const plan = await Quest.find({ sessionId: 'plan-1', correctsQuestId: { $ne: null }, deletedAt: null })
      .sort({ timestamp: 1, _id: 1 })
      .explain('queryPlanner');

    expect(JSON.stringify((plan as Record<string, any>).queryPlanner?.winningPlan)).toContain(
      '"indexName":"sessionId_correctsQuestId"'
    );
  });

  it('does not duplicate an existing index key pattern', () => {
    const patterns = Quest.schema.indexes().map(([key]) => JSON.stringify(key));
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});
