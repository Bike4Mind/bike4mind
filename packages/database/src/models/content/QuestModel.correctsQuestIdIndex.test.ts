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
    // A fresh in-memory collection has nothing to drop, so this is a real assertion on the
    // return value rather than the always-true resolves.toBeDefined().
    await expect(Quest.syncIndexes()).resolves.toEqual([]);
    const indexes = await Quest.collection.indexes();
    const idx = indexes.find(i => i.name === 'sessionId_correctsQuestId');
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ sessionId: 1, correctsQuestId: 1 });
    expect(idx?.sparse).toBeFalsy();
    expect(idx?.partialFilterExpression).toBeUndefined();
    expect(idx?.unique).toBeFalsy();
  });

  // In-memory mongod's planner is not DocumentDB's, and the docblock above
  // findCorrectionLinksBySessionId (QuestModel.ts) already concedes this index serves the match,
  // not the sort - so pinning a winning-plan shape here would prove a planner detail, not a prod
  // guarantee. What IS provable from any engine: the built collection has no two indexes sharing
  // a key pattern, which is what would produce an IndexKeySpecsConflict / duplicate-index warning.
  it('does not produce a duplicate index against the built collection', async () => {
    await Quest.syncIndexes();
    const indexes = await Quest.collection.indexes();
    const keyPatterns = indexes.map(i => JSON.stringify(i.key));

    expect(new Set(keyPatterns).size).toBe(keyPatterns.length);
  });

  it('does not duplicate an existing index key pattern', () => {
    const patterns = Quest.schema.indexes().map(([key]) => JSON.stringify(key));
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});
