import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { ISessionDocument, SessionListKeyset } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Quest } from '../content/QuestModel';
import { Session, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Session.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await Session.deleteMany({}, { hardDelete: true } as mongoose.QueryOptions);
  await Quest.collection.deleteMany({});
});

const OWNER = 'owner-1';

/** `count` notebooks where every pair shares a lastUpdated, so pages must break ties on _id. */
const seed = async (count: number) => {
  const docs = Array.from({ length: count }, (_, i) => ({
    name: `nb-${i}`,
    userId: OWNER,
    lastUpdated: new Date(Date.UTC(2026, 0, 1, 0, Math.floor(i / 2))),
    firstCreated: new Date(),
  }));
  await Session.insertMany(docs);
};

type Order = { field: string; direction: 'asc' | 'desc' };

const page = (order: Order, opts: { page?: number; after?: SessionListKeyset; search?: string; limit?: number }) =>
  sessionRepository.searchByUserId(
    opts.search,
    OWNER,
    {
      pagination: { page: opts.page ?? 1, limit: opts.limit ?? 3 },
      orderBy: { field: order.field as keyof ISessionDocument, direction: order.direction },
    },
    undefined,
    {},
    opts.after ? { after: opts.after } : {}
  );

const walkByOffset = async (order: Order, search?: string) => {
  const ids: string[] = [];
  for (let n = 1; ; n++) {
    const result = await page(order, { page: n, search });
    ids.push(...result.data.map(s => s.id));
    if (!result.hasMore) return ids;
  }
};

const walkByKeyset = async (order: Order, search?: string) => {
  const ids: string[] = [];
  let after: SessionListKeyset | undefined;
  for (;;) {
    const result = await page(order, { after, search });
    ids.push(...result.data.map(s => s.id));
    if (!result.hasMore) {
      expect(result.last).toBeUndefined();
      return ids;
    }
    expect(result.last).toBeDefined();
    after = result.last;
  }
};

describe('sessionRepository.searchByUserId paging', () => {
  it.each<Order>([
    { field: 'lastUpdated', direction: 'desc' },
    { field: 'lastUpdated', direction: 'asc' },
    { field: '_id', direction: 'asc' },
    { field: '_id', direction: 'desc' },
  ])('serves every row exactly once, in the offset order, by keyset ($field $direction)', async order => {
    await seed(10);
    const byOffset = await walkByOffset(order);
    expect(byOffset).toHaveLength(10);
    expect(new Set(byOffset).size).toBe(10);
    expect(await walkByKeyset(order)).toEqual(byOffset);
  });

  it('keeps the search $or and the keyset bound independent', async () => {
    await seed(10);
    await Session.updateMany({ name: { $in: ['nb-1', 'nb-4', 'nb-5', 'nb-8'] } }, { $set: { summary: 'needle' } });
    const order: Order = { field: 'lastUpdated', direction: 'desc' };
    const ids = await walkByKeyset(order, 'needle');
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(await walkByOffset(order, 'needle'));
  });

  it('examines limit + 1 rows for a deep keyset page, where offset examines every earlier row', async () => {
    await seed(40);
    const order: Order = { field: 'lastUpdated', direction: 'desc' };
    const after = (await page(order, { page: 9 })).last!;
    const deep = await page(order, { page: 10 });
    expect((await page(order, { after })).data.map(s => s.id)).toEqual(deep.data.map(s => s.id));

    // The same filter and sort searchByUserId builds, explained directly.
    const base = { deletedAt: null, userId: OWNER, surface: null };
    const sort = { lastUpdated: -1, _id: -1 } as const;
    const keysetClause = {
      $or: [
        { lastUpdated: { $lt: after.at } },
        { lastUpdated: after.at, _id: { $lt: new mongoose.Types.ObjectId(after.id) } },
      ],
    };
    const examined = async (query: mongoose.Query<unknown, unknown>) =>
      ((await query.explain('executionStats')) as unknown as { executionStats: { totalDocsExamined: number } })
        .executionStats.totalDocsExamined;
    // Each $or arm is an index-bounded scan that stops at limit + 1, so the cost is flat in depth.
    expect(
      await examined(
        Session.find({ ...base, $and: [keysetClause] })
          .sort(sort)
          .limit(4)
      )
    ).toBeLessThanOrEqual(8);
    expect(await examined(Session.find(base).sort(sort).skip(27).limit(4))).toBeGreaterThanOrEqual(31);
  });

  it('returns an empty page for a keyset id that cannot address a row', async () => {
    await seed(3);
    const result = await page({ field: '_id', direction: 'desc' }, { after: { id: 'not-an-object-id' } });
    expect(result).toEqual({ data: [], hasMore: false });
  });

  it('rejects a keyset for an order it cannot resume', async () => {
    await expect(
      page({ field: 'name', direction: 'asc' }, { after: { id: new mongoose.Types.ObjectId().toHexString() } })
    ).rejects.toThrow(/cannot resume a keyset/);
  });

  it('mints no keyset for an order that pages by offset only', async () => {
    await seed(5);
    const result = await page({ field: 'name', direction: 'asc' }, {});
    expect(result.hasMore).toBe(true);
    expect(result.last).toBeUndefined();
  });

  it('counts messages for rows with no stored count without writing them back', async () => {
    await seed(2);
    const [stored, missing] = await Session.find({ userId: OWNER }).sort({ name: 1 });
    await Session.collection.updateOne({ _id: stored._id }, { $set: { messageCount: 7 } });
    await Quest.collection.insertMany([
      { sessionId: missing.id, createdAt: new Date() },
      { sessionId: missing.id, createdAt: new Date() },
      { sessionId: missing.id, createdAt: new Date(), deletedAt: new Date() },
    ]);

    const { data } = await page({ field: 'lastUpdated', direction: 'desc' }, { limit: 10 });
    const counts = Object.fromEntries(data.map(s => [s.id, s.messageCount]));
    expect(counts).toEqual({ [stored.id]: 7, [missing.id]: 2 });

    const raw = await Session.collection.findOne({ _id: missing._id });
    expect(raw).not.toHaveProperty('messageCount');
  });

  it('does not read the fields the list response redacts', async () => {
    await Session.create({
      name: 'prompted',
      userId: OWNER,
      lastUpdated: new Date(),
      firstCreated: new Date(),
      systemPromptText: 'server-owned prompt',
    });
    const { data } = await page({ field: 'lastUpdated', direction: 'desc' }, {});
    expect(data[0].name).toBe('prompted');
    expect(data[0].systemPromptText).toBeUndefined();
  });
});
