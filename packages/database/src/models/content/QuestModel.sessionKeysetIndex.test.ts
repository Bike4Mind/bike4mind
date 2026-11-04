import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'sessionId_timestamp_id';
const SESSION_ID = 'keyset-session';
const TURNS = 300;
const LIMIT = 20;

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await Quest.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('Quest session keyset index', () => {
  it('builds the named index with the full sort key', async () => {
    const idx = (await Quest.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx?.key).toEqual({ sessionId: 1, timestamp: 1, _id: 1 });
    expect(idx?.sparse).toBeFalsy();
    expect(idx?.partialFilterExpression).toBeUndefined();
  });

  it('does not duplicate an existing index key pattern', () => {
    const patterns = Quest.schema.indexes().map(([key]) => JSON.stringify(key));
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  // Walks findPageAfterBySessionId over a whole session and reads each page's cost from the
  // profiler, so a regression in either the index or the cursor filter shows up here.
  it('examines about one page of documents per page across a 300-turn session', async () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    // Pairs of turns share a timestamp so the _id tie-break is exercised on every page.
    await Quest.collection.insertMany(
      Array.from({ length: TURNS }, (_, i) => ({
        sessionId: SESSION_ID,
        type: 'message',
        status: 'done',
        deletedAt: null,
        timestamp: new Date(base + Math.floor(i / 2) * 1000),
      }))
    );
    // Another session's turns sit in the same index; they must not be scanned either.
    await Quest.collection.insertMany(
      Array.from({ length: TURNS }, (_, i) => ({
        sessionId: 'other-session',
        type: 'message',
        status: 'done',
        deletedAt: null,
        timestamp: new Date(base + i * 1000),
      }))
    );

    const db = mongoose.connection.db!;
    await db.command({ profile: 0 });
    await db
      .collection('system.profile')
      .drop()
      .catch(() => {});
    await db.command({ profile: 2 });

    const seen: string[] = [];
    let after: { timestamp: Date; id: string } | undefined;
    for (;;) {
      const page = await questRepository.findPageAfterBySessionId(SESSION_ID, { limit: LIMIT, after });
      if (page.length === 0) break;
      seen.push(...page.map(q => q.id));
      const last = page[page.length - 1];
      after = { timestamp: last.timestamp, id: last.id };
    }

    await db.command({ profile: 0 });

    const expected = (
      await Quest.collection.find({ sessionId: SESSION_ID }).sort({ timestamp: 1, _id: 1 }).toArray()
    ).map(d => d._id.toString());
    expect(seen).toEqual(expected);

    const finds = await db
      .collection('system.profile')
      .find({ ns: `${db.databaseName}.${Quest.collection.collectionName}`, op: 'query' })
      .toArray();
    expect(finds).toHaveLength(TURNS / LIMIT + 1);
    for (const op of finds) {
      expect(op.planSummary).toBe('IXSCAN { sessionId: 1, timestamp: 1, _id: 1 }');
      expect(op.hasSortStage).toBeFalsy();
      // One page, plus the turns at the cursor's own timestamp the $gte bound re-reads (a pair here).
      expect(op.docsExamined).toBeLessThanOrEqual(LIMIT + 2);
    }
  });
});
