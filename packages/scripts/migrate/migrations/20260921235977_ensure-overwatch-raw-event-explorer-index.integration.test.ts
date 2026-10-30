import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { OverwatchRawEvent, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235977_ensure-overwatch-raw-event-explorer-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'productId_1_event_1_timestamp_-1';
// The index every product-window read already uses. The migration builds ONE index, so this one
// staying dropped guards that narrowing; the planner test rebuilds it to compete against.
const WINDOW_INDEX_NAME = 'productId_1_timestamp_-1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await OverwatchRawEvent.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(OverwatchRawEvent.collection.collectionName).catch(() => {});
  await OverwatchRawEvent.collection.deleteMany({});
  // autoIndex may have built it on connect; the migration's job is to build it where it is absent.
  await safeDropIndex(OverwatchRawEvent.collection, INDEX_NAME);
  await safeDropIndex(OverwatchRawEvent.collection, WINDOW_INDEX_NAME);
});

/** Every index name the winning plan reads, wherever the engine nests its stages. */
function indexNamesIn(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const node = plan as Record<string, unknown>;
  const own = typeof node.indexName === 'string' ? [node.indexName] : [];
  return [...own, ...Object.values(node).flatMap(indexNamesIn)];
}

async function winningIndexes(filter: Record<string, unknown>, sort?: Record<string, 1 | -1>): Promise<string[]> {
  const cursor = OverwatchRawEvent.collection.find(filter);
  if (sort) cursor.sort(sort).limit(1);
  const explained = (await cursor.explain('queryPlanner')) as { queryPlanner: { winningPlan: unknown } };
  return [...new Set(indexNamesIn(explained.queryPlanner.winningPlan))];
}

/** The same for an aggregation: its plan sits under the leading `$cursor` unless the engine pushed the whole pipeline down. */
async function winningAggregateIndexes(pipeline: Record<string, unknown>[]): Promise<string[]> {
  const explained = (await OverwatchRawEvent.collection.aggregate(pipeline).explain('queryPlanner')) as {
    queryPlanner?: { winningPlan: unknown };
    stages?: { $cursor?: { queryPlanner?: { winningPlan: unknown } } }[];
  };
  const planner = explained.queryPlanner ?? explained.stages?.[0]?.$cursor?.queryPlanner;
  return [...new Set(indexNamesIn(planner?.winningPlan))];
}

describe('ensure-overwatch-raw-event-explorer-index migration (real DB)', () => {
  it('builds the product, event, timestamp index', async () => {
    let idx = (await OverwatchRawEvent.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    const indexes = await OverwatchRawEvent.collection.indexes();
    idx = indexes.find(i => i.name === INDEX_NAME);
    // Key ORDER is the point: both equalities first, so the timestamp range is one bounded scan per event.
    expect(idx?.key).toEqual({ productId: 1, event: 1, timestamp: -1 });
    expect(indexes.find(i => i.name === WINDOW_INDEX_NAME)).toBeUndefined();
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await OverwatchRawEvent.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });

  it('agrees with the schema declaration, so autoIndex after it is a no-op', async () => {
    await migration.up();
    // What autoIndex runs on every cold boot. Name or option drift between the schema and the migration
    // fails whichever builds second with IndexOptionsConflict, and when that is the migration, the deploy.
    await OverwatchRawEvent.createIndexes();

    const sameKey = (await OverwatchRawEvent.collection.indexes()).filter(
      i => JSON.stringify(i.key) === JSON.stringify({ productId: 1, event: 1, timestamp: -1 })
    );
    expect(sameKey.map(i => i.name)).toEqual([INDEX_NAME]);
  });

  it('wins the plan for a named-event range read over the product-window index', async () => {
    await OverwatchRawEvent.collection.createIndex({ productId: 1, timestamp: -1 });
    await migration.up();

    // A product window dominated by events the read does not name, which is the case the index is for.
    const common = ['visit', 'article_read', 'cta_click'];
    await OverwatchRawEvent.collection.insertMany(
      Array.from({ length: 500 }, (_, i) => ({
        eventId: `e-${i}`,
        schemaVersion: 1,
        productId: 'blog',
        userId: `u-${i % 40}`,
        sessionId: `s-${i % 80}`,
        event: i % 50 === 0 ? 'signup' : i % 50 === 25 ? 'purchase' : common[i % 3],
        timestamp: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
        createdAt: new Date(),
      })) as never[]
    );
    const range = { $gte: '2026-10-01T00:00:00.000Z', $lt: '2026-10-02T00:00:00.000Z' };

    // The explorer's event view: one event.
    expect(await winningIndexes({ productId: 'blog', event: 'signup', timestamp: range })).toEqual([INDEX_NAME]);
    // The funnel, attribution and roads: an `$in` of a few.
    expect(
      await winningIndexes({ productId: 'blog', event: { $in: ['signup', 'purchase'] }, timestamp: range })
    ).toEqual([INDEX_NAME]);
    // The explorer reads through aggregations, with its credited and user-action residuals in the head `$match`.
    const explorerMatch = {
      productId: 'blog',
      event: 'signup',
      timestamp: range,
      'metadata.attribution': { $ne: 'self-reported' },
      'metadata.userAction': { $nin: [false, 'false'] },
    };
    expect(
      await winningAggregateIndexes([{ $match: explorerMatch }, { $group: { _id: '$userId', n: { $sum: 1 } } }])
    ).toEqual([INDEX_NAME]);
    // Why the product-window index stays: data health's newest-event seek names no event, and only
    // that index hands back a product's events in timestamp order.
    expect(await winningIndexes({ productId: 'blog' }, { timestamp: -1 })).toEqual([WINDOW_INDEX_NAME]);
  });
});
