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
      // Every third pair shares a timestamp to exercise the _id tiebreak.
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
    const mid = await Quest.collection
      .find({ sessionId: SESSION })
      .sort({ timestamp: 1, _id: 1 })
      .skip(150)
      .limit(1)
      .next();
    const db = mongoose.connection.db!;
    await db.command({ profile: 2 });
    await questRepository.findPageAfterBySessionId(SESSION, {
      limit: 25,
      after: { timestamp: mid!.timestamp, id: String(mid!._id) },
    });
    await db.command({ profile: 0 });
    const [op] = await db
      .collection('system.profile')
      .find({ ns: `${db.databaseName}.${Quest.collection.collectionName}`, op: 'query' })
      .sort({ ts: -1 })
      .limit(1)
      .toArray();
    expect(op.docsExamined).toBeLessThanOrEqual(30);
  });
});
