import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX, OverwatchUserDay, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235978_ensure-overwatch-user-day-synthetic-lane-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX;
// The index every product-and-date read already uses. The migration builds ONE index, so this one
// staying dropped guards that narrowing; the planner test rebuilds it to compete against.
const UNIQUE_INDEX_NAME = 'productId_1_date_1_userId_1';
// The default name an unfiltered index on the same key gets, which a stage may already have.
const UNFILTERED_SAME_KEY_NAME = 'productId_1_date_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await OverwatchUserDay.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(OverwatchUserDay.collection.collectionName).catch(() => {});
  await OverwatchUserDay.collection.deleteMany({});
  // autoIndex may have built it on connect; the migration's job is to build it where it is absent.
  await safeDropIndex(OverwatchUserDay.collection, INDEX_NAME);
  await safeDropIndex(OverwatchUserDay.collection, UNIQUE_INDEX_NAME);
  await safeDropIndex(OverwatchUserDay.collection, UNFILTERED_SAME_KEY_NAME);
});

/** Every index name the winning plan reads, wherever the engine nests its stages. */
function indexNamesIn(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const node = plan as Record<string, unknown>;
  const own = typeof node.indexName === 'string' ? [node.indexName] : [];
  return [...own, ...Object.values(node).flatMap(indexNamesIn)];
}

async function winningIndexes(filter: Record<string, unknown>): Promise<string[]> {
  const explained = (await OverwatchUserDay.collection.find(filter).explain('queryPlanner')) as {
    queryPlanner: { winningPlan: unknown };
  };
  return [...new Set(indexNamesIn(explained.queryPlanner.winningPlan))];
}

/** The same for an aggregation: its plan sits under the leading `$cursor` unless the engine pushed the whole pipeline down. */
async function winningAggregateIndexes(pipeline: Record<string, unknown>[]): Promise<string[]> {
  const explained = (await OverwatchUserDay.collection.aggregate(pipeline).explain('queryPlanner')) as {
    queryPlanner?: { winningPlan: unknown };
    stages?: { $cursor?: { queryPlanner?: { winningPlan: unknown } } }[];
  };
  const planner = explained.queryPlanner ?? explained.stages?.[0]?.$cursor?.queryPlanner;
  return [...new Set(indexNamesIn(planner?.winningPlan))];
}

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;

/** 30 days of two products, 20 users a day each, of whom only the first two are marked synthetic. */
async function seedUserDays(): Promise<number> {
  const docs = ['blog', 'app'].flatMap(productId =>
    Array.from({ length: 30 }, (_, d) =>
      Array.from({ length: 20 }, (_, u) => ({
        productId,
        date: day(d + 1),
        userId: `u-${u}`,
        ...(u < 2 ? { lane: 'synthetic' } : {}),
        createdAt: new Date(),
      }))
    ).flat()
  );
  await OverwatchUserDay.collection.insertMany(docs as never[]);
  return docs.filter(d => 'lane' in d).length;
}

describe('ensure-overwatch-user-day-synthetic-lane-index migration (real DB)', () => {
  it('builds the partial product, date index over synthetic rows', async () => {
    let idx = (await OverwatchUserDay.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    const indexes = await OverwatchUserDay.collection.indexes();
    idx = indexes.find(i => i.name === INDEX_NAME);
    expect(idx?.key).toEqual({ productId: 1, date: 1 });
    // The filter is the point: only marked rows get a key, and only a read naming the lane may use it.
    expect(idx?.partialFilterExpression).toEqual({ lane: 'synthetic' });
    expect(idx?.unique).toBeFalsy();
    expect(indexes.find(i => i.name === UNIQUE_INDEX_NAME)).toBeUndefined();
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await OverwatchUserDay.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });

  it('builds beside an unfiltered index on the same key without a conflict, and leaves it alone', async () => {
    // Unnamed, the partial index would take this default name and fail on such a stage.
    await OverwatchUserDay.collection.createIndex({ productId: 1, date: 1 });

    await migration.up();
    await migration.up();
    await OverwatchUserDay.createIndexes();

    const sameKey = (await OverwatchUserDay.collection.indexes())
      .filter(i => JSON.stringify(i.key) === JSON.stringify({ productId: 1, date: 1 }))
      .map(i => ({ name: i.name, partialFilterExpression: i.partialFilterExpression }))
      .sort((a, b) => a.name!.localeCompare(b.name!));
    expect(sameKey).toEqual([
      { name: UNFILTERED_SAME_KEY_NAME, partialFilterExpression: undefined },
      { name: INDEX_NAME, partialFilterExpression: { lane: 'synthetic' } },
    ]);
  });

  it('agrees with the schema declaration, so autoIndex after it is a no-op', async () => {
    await migration.up();
    // What autoIndex runs on every cold boot. Name or option drift between the schema and the migration
    // fails whichever builds second with IndexOptionsConflict, and when that is the migration, the deploy.
    await OverwatchUserDay.createIndexes();

    const sameKey = (await OverwatchUserDay.collection.indexes()).filter(
      i => JSON.stringify(i.key) === JSON.stringify({ productId: 1, date: 1 })
    );
    expect(sameKey.map(i => i.name)).toEqual([INDEX_NAME]);
  });

  it('is a no-op when autoIndex built the index first', async () => {
    // A Lambda cold boot can finish the schema's build before the migrator runs on that deploy.
    await OverwatchUserDay.createIndexes();
    await migration.up();

    const sameKey = (await OverwatchUserDay.collection.indexes()).filter(
      i => JSON.stringify(i.key) === JSON.stringify({ productId: 1, date: 1 })
    );
    expect(sameKey.map(i => ({ name: i.name, partialFilterExpression: i.partialFilterExpression }))).toEqual([
      { name: INDEX_NAME, partialFilterExpression: { lane: 'synthetic' } },
    ]);
  });

  it('wins the plan for synthetic-lane reads and is never used by reads that do not name the lane', async () => {
    await OverwatchUserDay.collection.createIndex({ productId: 1, date: 1, userId: 1 }, { unique: true });
    await migration.up();
    const marked = await seedUserDays();
    const range = { $gte: day(1), $lte: day(30) };

    // Per-product daily counts across products.
    expect(
      await winningAggregateIndexes([
        { $match: { productId: { $in: ['blog', 'app'] }, date: range, lane: 'synthetic' } },
        { $group: { _id: { productId: '$productId', date: '$date' }, n: { $sum: 1 } } },
      ])
    ).toEqual([INDEX_NAME]);
    // One product's lane WAU/MAU window, and its lane DAU for one day or a set of days.
    expect(await winningIndexes({ productId: 'blog', date: range, lane: 'synthetic' })).toEqual([INDEX_NAME]);
    expect(await winningIndexes({ productId: 'blog', date: day(5), lane: 'synthetic' })).toEqual([INDEX_NAME]);
    expect(await winningIndexes({ productId: 'blog', date: { $in: [day(3), day(4)] }, lane: 'synthetic' })).toEqual([
      INDEX_NAME,
    ]);

    // A partial index may only serve a read whose filter implies its own, so the unmarked and
    // all-users reads keep the unique index.
    expect(await winningIndexes({ productId: 'blog', date: day(5) })).toEqual([UNIQUE_INDEX_NAME]);
    expect(await winningIndexes({ productId: 'blog', date: range, lane: { $ne: 'synthetic' } })).toEqual([
      UNIQUE_INDEX_NAME,
    ]);

    // Only marked rows are keyed: the cross-product read examines exactly those.
    const stats = (await OverwatchUserDay.collection
      .find({ productId: { $in: ['blog', 'app'] }, date: range, lane: 'synthetic' })
      .explain('executionStats')) as { executionStats: { totalKeysExamined: number; nReturned: number } };
    expect(stats.executionStats.nReturned).toBe(marked);
    expect(stats.executionStats.totalKeysExamined).toBeLessThanOrEqual(marked + 2);
  });
});
