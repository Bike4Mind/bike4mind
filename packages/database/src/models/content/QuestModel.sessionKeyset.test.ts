import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Quest, questRepository } from './QuestModel';

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

const SESSION = new mongoose.Types.ObjectId().toString();

describe('findPageAfterBySessionId', () => {
  it('walks every live turn once, in (timestamp, _id) order, and reads only one page per call', async () => {
    const base = Date.UTC(2026, 0, 1);
    const docs = Array.from({ length: 300 }, (_, i) => ({
      sessionId: SESSION,
      userId: 'u1',
      // Each consecutive pair shares a timestamp to exercise the _id tiebreak.
      timestamp: new Date(base + Math.floor(i / 2) * 1000),
      prompts: [`p${i}`],
    }));
    docs.push({
      sessionId: new mongoose.Types.ObjectId().toString(),
      userId: 'u2',
      timestamp: new Date(base),
      prompts: ['x'],
    });
    await Quest.collection.insertMany(docs);
    await Quest.collection.insertOne({
      sessionId: SESSION,
      userId: 'u1',
      timestamp: new Date(base + 5),
      prompts: ['gone'],
      deletedAt: new Date(),
    });

    const seen: string[] = [];
    let after: { timestamp: Date; id: string } | undefined;
    for (;;) {
      const page = await questRepository.findPageAfterBySessionId(SESSION, { limit: 25, after });
      seen.push(...page.map(q => String(q.id)));
      if (page.length < 25) break;
      const last = page[page.length - 1];
      after = { timestamp: last.timestamp as Date, id: String(last.id) };
    }
    const expected = (
      await Quest.collection.find({ sessionId: SESSION, deletedAt: null }).sort({ timestamp: 1, _id: 1 }).toArray()
    ).map(d => String(d._id));
    expect(seen).toEqual(expected);
    expect(seen).toHaveLength(300);

    // Mid-session cursor: the keyset must bound the scan to about one page, not the rest of the session.
    // Mirrors the filter findPageAfterBySessionId builds; keep the two in sync.
    const mid = await Quest.collection.findOne({ _id: new mongoose.Types.ObjectId(expected[150]) });
    const explanation: unknown = await Quest.collection
      .find({
        sessionId: SESSION,
        deletedAt: null,
        timestamp: { $gte: mid!.timestamp },
        $or: [{ timestamp: { $gt: mid!.timestamp } }, { timestamp: mid!.timestamp, _id: { $gt: mid!._id } }],
      })
      .sort({ timestamp: 1, _id: 1 })
      .limit(25)
      .explain('executionStats');

    // Mongo versions may place the cursor inside wrapper stages or at the top level.
    const findProperties = (value: unknown, name: string): unknown[] => {
      if (value === null || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => [
        ...(key === name ? [child] : []),
        ...findProperties(child, name),
      ]);
    };
    const winningPlans = findProperties(explanation, 'winningPlan');
    expect(winningPlans).toHaveLength(1);
    // A SORT-stage check would not discriminate: a backward scan of deletedAt_timestamp_id_desc
    // also yields (timestamp, _id) ascending without one.
    expect(findProperties(winningPlans[0], 'indexName')).toContain('sessionId_timestamp_id');
    const [docsExamined] = findProperties(explanation, 'totalDocsExamined');
    expect(docsExamined).toBeLessThanOrEqual(30);
  });
});

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
