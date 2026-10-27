import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { type PipelineStage } from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { getActivitySummary } from './getActivitySummary';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { aggregate } = vi.hoisted(() => ({ aggregate: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ CounterLog: { aggregate } }));

const TestCounter = mongoose.model(
  'DashboardActivityTest',
  new mongoose.Schema({ counterName: String, datetime: Date, metadata: mongoose.Schema.Types.Mixed })
);
let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;
const now = new Date('2026-10-21T12:00:00.000Z');

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  aggregate.mockImplementation((pipeline: PipelineStage[]) => TestCounter.aggregate(pipeline));
});

beforeEach(async () => {
  await TestCounter.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('dashboard activity aggregation', () => {
  it('includes older days even when today alone has more than 1,000 events', async () => {
    await TestCounter.insertMany([
      ...Array.from({ length: 1001 }, () => ({ counterName: 'Session Created', datetime: now })),
      { counterName: 'File Uploaded', datetime: new Date('2026-10-15T00:00:00Z') },
      { counterName: 'File Uploaded', datetime: new Date('2026-10-18T23:59:59Z') },
      { counterName: 'Session Created', datetime: new Date('2026-10-14T23:59:59Z') },
      { counterName: 'Session Created', datetime: new Date('2026-10-21T12:00:01Z') },
    ]);

    const result = await getActivitySummary(now);

    expect(result.totalEvents).toBe(1003);
    expect(result.timeSeriesData).toEqual([
      { date: '2026-10-15', count: 1 },
      { date: '2026-10-16', count: 0 },
      { date: '2026-10-17', count: 0 },
      { date: '2026-10-18', count: 1 },
      { date: '2026-10-19', count: 0 },
      { date: '2026-10-20', count: 0 },
      { date: '2026-10-21', count: 1001 },
    ]);
    expect(result.topEvents).toEqual([
      { eventName: 'Session Created', category: 'Session', count: 1001 },
      { eventName: 'File Uploaded', category: 'File', count: 2 },
    ]);
    expect(result.categoryBreakdown.map(({ category, count }) => ({ category, count }))).toEqual([
      { category: 'Session', count: 1001 },
      { category: 'File', count: 2 },
    ]);
  });

  it('leaves Overwatch ingest key use out of the summary but keeps other key use', async () => {
    await TestCounter.insertMany([
      ...Array.from({ length: 3 }, () => ({
        counterName: 'User API Key Used',
        datetime: now,
        metadata: { endpoint: '/api/overwatch/v1/events' },
      })),
      { counterName: 'User API Key Used', datetime: now, metadata: { endpoint: '/api/v1/sessions' } },
      { counterName: 'User API Key Used', datetime: now },
      { counterName: 'Session Created', datetime: now, metadata: { endpoint: '/api/overwatch/v1/events' } },
    ]);

    const result = await getActivitySummary(now);

    expect(result.totalEvents).toBe(3);
    expect(result.topEvents.map(({ eventName, count }) => ({ eventName, count }))).toEqual([
      { eventName: 'User API Key Used', count: 2 },
      { eventName: 'Session Created', count: 1 },
    ]);
  });

  it('returns all seven zero days for an empty window and advances the window at UTC midnight', async () => {
    const result = await getActivitySummary(new Date('2026-10-22T00:00:00Z'));
    expect(result.windowStart).toBe('2026-10-16T00:00:00.000Z');
    expect(result.totalEvents).toBe(0);
    expect(result.timeSeriesData).toHaveLength(7);
    expect(result.timeSeriesData.at(-1)).toEqual({ date: '2026-10-22', count: 0 });
    expect(result.timeSeriesData.every(day => day.count === 0)).toBe(true);
    expect(result.categoryBreakdown).toEqual([]);
    expect(result.topEvents).toEqual([]);
  });
});
