import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { OVERWATCH_RAW_EVENT_CREDITED_INDEX, OverwatchRawEvent } from './OverwatchRawEventModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

const PRODUCT = 'blog';
const CREDIT = { 'metadata.attribution': 'self-reported' };
const ts = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await OverwatchRawEvent.init();
  // Every 50th event (offset 25) is a credit, so the newest event is never one.
  await OverwatchRawEvent.collection.insertMany(
    Array.from({ length: 500 }, (_, i) => ({
      eventId: `e-${i}`,
      schemaVersion: 1,
      productId: PRODUCT,
      userId: `u-${i}`,
      sessionId: `s-${i}`,
      event: 'page_view',
      timestamp: ts(i),
      createdAt: new Date(),
      ...(i % 50 === 25 ? { metadata: { attribution: 'self-reported' } } : {}),
    }))
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

/** Every index name in a plan tree, so a nested FETCH -> IXSCAN still reports the index. */
const indexNamesIn = (plan: Record<string, unknown> | undefined): string[] => {
  if (!plan) return [];
  const own = typeof plan.indexName === 'string' ? [plan.indexName] : [];
  const children = [plan.inputStage, ...((plan.inputStages as unknown[]) ?? [])].filter(Boolean);
  return [...own, ...children.flatMap(c => indexNamesIn(c as Record<string, unknown>))];
};

const plannedIndexes = async (filter: Record<string, unknown>, limit?: number) => {
  let q = OverwatchRawEvent.collection.find(filter).sort({ timestamp: -1 });
  if (limit) q = q.limit(limit);
  const explain = await q.explain('queryPlanner');
  return indexNamesIn(explain.queryPlanner.winningPlan);
};

describe('OverwatchRawEvent credited index', () => {
  it('is declared next to the unfiltered index of the same key', async () => {
    const indexes = await OverwatchRawEvent.collection.indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: OVERWATCH_RAW_EVENT_CREDITED_INDEX,
        key: { productId: 1, timestamp: -1 },
        partialFilterExpression: CREDIT,
      })
    );
    expect(indexes.map(i => i.name)).toContain('productId_1_timestamp_-1');
  });

  it('serves a credit seek', async () => {
    expect(await plannedIndexes({ productId: PRODUCT, ...CREDIT }, 1)).toEqual([OVERWATCH_RAW_EVENT_CREDITED_INDEX]);
  });

  it('serves a credit range read', async () => {
    const filter = { productId: PRODUCT, ...CREDIT, timestamp: { $gte: ts(100), $lte: ts(400) } };
    expect(await plannedIndexes(filter)).toEqual([OVERWATCH_RAW_EVENT_CREDITED_INDEX]);
  });

  it('is not used by reads without the equality', async () => {
    expect(await plannedIndexes({ productId: PRODUCT }, 1)).not.toContain(OVERWATCH_RAW_EVENT_CREDITED_INDEX);
    expect(
      await plannedIndexes({ productId: PRODUCT, 'metadata.attribution': { $ne: 'self-reported' } })
    ).not.toContain(OVERWATCH_RAW_EVENT_CREDITED_INDEX);
  });

  it('holds only the credited events', async () => {
    const hinted = await OverwatchRawEvent.collection
      .find({ productId: PRODUCT }, { hint: OVERWATCH_RAW_EVENT_CREDITED_INDEX })
      .toArray();
    expect(hinted).toHaveLength(10);
  });
});
