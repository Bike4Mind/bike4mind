import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import {
  OVERWATCH_USER_DAY_INTERNAL_INDEX,
  OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX,
  OverwatchUserDay,
  safeDropIndex,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921239900_ensure-overwatch-user-day-internal-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = OVERWATCH_USER_DAY_INTERNAL_INDEX;
const SYNTHETIC_INDEX_NAME = OVERWATCH_USER_DAY_SYNTHETIC_LANE_INDEX;
// The index every product-and-date read already uses; the planner test rebuilds it to compete against.
const UNIQUE_INDEX_NAME = 'productId_1_date_1_userId_1';

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
  // autoIndex may have built them on connect; the migration's job is to build this one where it is absent.
  await safeDropIndex(OverwatchUserDay.collection, INDEX_NAME);
  await safeDropIndex(OverwatchUserDay.collection, SYNTHETIC_INDEX_NAME);
  await safeDropIndex(OverwatchUserDay.collection, UNIQUE_INDEX_NAME);
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
  return [...new Set(indexNamesIn(explained.queryPlanner.winningPlan))].sort();
}

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;

/** 30 days of two products, 20 users a day each: two marked synthetic, two marked internal. */
async function seedUserDays(): Promise<number> {
  const docs = ['blog', 'app'].flatMap(productId =>
    Array.from({ length: 30 }, (_, d) =>
      Array.from({ length: 20 }, (_, u) => ({
        productId,
        date: day(d + 1),
        userId: `u-${u}`,
        ...(u < 2 ? { lane: 'synthetic' } : {}),
        ...(u >= 2 && u < 4 ? { internal: true } : {}),
        createdAt: new Date(),
      }))
    ).flat()
  );
  await OverwatchUserDay.collection.insertMany(docs as never[]);
  return docs.filter(d => d.productId === 'blog' && 'internal' in d).length;
}

describe('ensure-overwatch-user-day-internal-index migration (real DB)', () => {
  it('builds the partial product, date index over internal rows, and only that index', async () => {
    let idx = (await OverwatchUserDay.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    const indexes = await OverwatchUserDay.collection.indexes();
    idx = indexes.find(i => i.name === INDEX_NAME);
    expect(idx?.key).toEqual({ productId: 1, date: 1 });
    // The filter is the point: only marked rows get a key, and only a read naming the mark may use it.
    expect(idx?.partialFilterExpression).toEqual({ internal: true });
    expect(idx?.unique).toBeFalsy();
    expect(indexes.find(i => i.name === SYNTHETIC_INDEX_NAME)).toBeUndefined();
    expect(indexes.find(i => i.name === UNIQUE_INDEX_NAME)).toBeUndefined();
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await OverwatchUserDay.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });

  it('agrees with the schema declaration, so autoIndex after it is a no-op', async () => {
    await migration.up();
    // What autoIndex runs on every cold boot. Name or option drift between the schema and the migration
    // fails whichever builds second with IndexOptionsConflict, and when that is the migration, the deploy.
    await OverwatchUserDay.createIndexes();

    const sameKey = (await OverwatchUserDay.collection.indexes())
      .filter(i => JSON.stringify(i.key) === JSON.stringify({ productId: 1, date: 1 }))
      .map(i => ({ name: i.name, partialFilterExpression: i.partialFilterExpression }))
      .sort((a, b) => a.name!.localeCompare(b.name!));
    expect(sameKey).toEqual([
      { name: INDEX_NAME, partialFilterExpression: { internal: true } },
      { name: SYNTHETIC_INDEX_NAME, partialFilterExpression: { lane: 'synthetic' } },
    ]);
  });

  it('is a no-op when autoIndex built the index first', async () => {
    // A Lambda cold boot can finish the schema's build before the migrator runs on that deploy.
    await OverwatchUserDay.createIndexes();
    await migration.up();

    const idx = (await OverwatchUserDay.collection.indexes()).filter(i => i.name === INDEX_NAME);
    expect(idx.map(i => i.partialFilterExpression)).toEqual([{ internal: true }]);
  });

  it('wins the plan for internal reads, serves each branch of a per-mark $or, and no read without the mark', async () => {
    await OverwatchUserDay.createIndexes();
    await migration.up();
    const marked = await seedUserDays();
    const range = { $gte: day(1), $lte: day(30) };

    // One product's internal window, and one day of it.
    expect(await winningIndexes({ productId: 'blog', date: range, internal: true })).toEqual([INDEX_NAME]);
    expect(await winningIndexes({ productId: 'blog', date: day(5), internal: true })).toEqual([INDEX_NAME]);
    // Either mark, one branch per mark, each naming the product and range: each branch on its own index.
    expect(
      await winningIndexes({
        $or: [
          { productId: 'blog', date: range, lane: 'synthetic' },
          { productId: 'blog', date: range, internal: true },
        ],
      })
    ).toEqual([INDEX_NAME, SYNTHETIC_INDEX_NAME].sort());

    // A partial index may only serve a read whose filter implies its own.
    expect(await winningIndexes({ productId: 'blog', date: day(5) })).toEqual([UNIQUE_INDEX_NAME]);
    expect(await winningIndexes({ productId: 'blog', date: range, internal: { $ne: true } })).toEqual([
      UNIQUE_INDEX_NAME,
    ]);

    // Only marked rows are keyed: the read examines exactly those.
    const stats = (await OverwatchUserDay.collection
      .find({ productId: 'blog', date: range, internal: true })
      .explain('executionStats')) as { executionStats: { totalKeysExamined: number; nReturned: number } };
    expect(stats.executionStats.nReturned).toBe(marked);
    expect(stats.executionStats.totalKeysExamined).toBeLessThanOrEqual(marked + 1);
  });
});
