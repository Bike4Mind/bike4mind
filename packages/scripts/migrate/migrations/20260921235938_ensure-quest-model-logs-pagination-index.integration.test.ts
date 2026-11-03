import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Quest, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235938_ensure-quest-model-logs-pagination-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'deletedAt_timestamp_id_desc';
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Quest.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Quest.collection.deleteMany({});
  // Awaiting init above prevents autoIndex from recreating this behind the migration test.
  await safeDropIndex(Quest.collection, INDEX_NAME);
});

describe('ensure quest model logs pagination index', () => {
  it('builds the full pagination index and is idempotent', async () => {
    expect((await Quest.collection.indexes()).find(index => index.name === INDEX_NAME)).toBeUndefined();

    await migration.up();
    await migration.up();

    const matchingIndexes = (await Quest.collection.indexes()).filter(index => index.name === INDEX_NAME);
    expect(matchingIndexes).toHaveLength(1);
    expect(matchingIndexes[0].key).toEqual({ deletedAt: 1, timestamp: -1, _id: -1 });
  });

  it('serves a page without sorting or fetching the rest of the matching range', async () => {
    await migration.up();
    const timestamp = new Date('2026-01-01T00:00:00Z');
    await Quest.collection.insertMany(
      Array.from({ length: 200 }, (_, index) => ({
        sessionId: 'model-logs-index',
        type: 'message',
        deletedAt: null,
        timestamp: new Date(timestamp.getTime() + index),
        promptMeta: { artifacts: [{ type: 'html', content: 'x'.repeat(8192) }] },
      }))
    );

    const explanation: unknown = await Quest.collection
      .aggregate([
        { $match: { deletedAt: null, timestamp: { $gte: timestamp } } },
        { $sort: { timestamp: -1, _id: -1 } },
        { $limit: 10 },
        { $project: { timestamp: 1, artifacts: '$promptMeta.artifacts' } },
      ])
      .explain('executionStats');

    // Mongo versions may place the cursor inside aggregation stages or at the top level.
    const findProperties = (value: unknown, name: string): unknown[] => {
      if (value === null || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => [
        ...(key === name ? [child] : []),
        ...findProperties(child, name),
      ]);
    };
    const winningPlans = findProperties(explanation, 'winningPlan');
    expect(winningPlans).toHaveLength(1);
    expect(findProperties(winningPlans[0], 'indexName')).toContain(INDEX_NAME);
    expect(findProperties(winningPlans[0], 'stage')).not.toContain('SORT');
    expect(findProperties(explanation, 'totalDocsExamined')).toEqual([10]);
    expect(findProperties(explanation, 'totalKeysExamined')).toEqual([10]);
  });
});
