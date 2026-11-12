import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { type FilterQuery } from 'mongoose';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import {
  DAY_MS,
  feedbackReceivedSince,
  sumFeedbackTypeCounts,
  type FeedbackReceivedWindow,
} from '@client/app/components/admin/Feedback/feedbackTrends';
import { buildFeedbackTrends, computeFeedbackTrends } from './feedbackTrends';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const TestFeedback = vi.hoisted(() => ({ model: undefined as unknown as mongoose.Model<Record<string, unknown>> }));
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: {
    countDocuments: (filter: FilterQuery<unknown>) => TestFeedback.model.countDocuments(filter),
    aggregate: (pipeline: mongoose.PipelineStage[]) => TestFeedback.model.aggregate(pipeline),
  },
}));

const schema = new mongoose.Schema({ status: String, type: String, createdAt: Date });
schema.index({ status: 1, createdAt: -1 });
TestFeedback.model = mongoose.model('FeedbackTrendsTest', schema);

const now = new Date('2026-11-11T12:00:00.000Z');
const ago = (days: number, extraMs = 0) => new Date(now.getTime() - days * DAY_MS - extraMs);

let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

beforeEach(async () => {
  await TestFeedback.model.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

/** The clauses GET /api/feedback builds for a figure's filter, every status checked. */
const listCount = (received: FeedbackReceivedWindow, types: FeedbackType[] = []) =>
  TestFeedback.model.countDocuments({
    status: { $in: Object.values(FeedbackStatus) },
    createdAt: { $gt: feedbackReceivedSince(received, now) },
    ...(types.length > 0 ? { type: { $in: types.includes(FeedbackType.FEEDBACK) ? [...types, null] : types } } : {}),
  });

describe('computeFeedbackTrends', () => {
  it.each([1, 7, 14, 30])('matches exclusive window bounds around day %s', async days => {
    await TestFeedback.model.insertMany(
      [-1, 0, 1].map(offset => ({
        status: FeedbackStatus.New,
        type: FeedbackType.THUMBS_DOWN,
        createdAt: ago(days, offset),
      }))
    );
    const trends = await computeFeedbackTrends(now);
    expect(trends.receivedLast24h).toBe(await listCount('24h'));
    expect(trends.receivedLast30d).toBe(await listCount('30d'));
    expect(trends.thumbsDownShare.current.total).toBe(await listCount('7d'));
    const prior = await TestFeedback.model.countDocuments({ createdAt: { $gt: ago(14), $lte: ago(7) } });
    expect(trends.thumbsDownShare.prior).toEqual({ total: prior, thumbsDown: prior });
  });

  it('matches a direct query for every figure the strip links to', async () => {
    await TestFeedback.model.insertMany([
      { status: FeedbackStatus.New, type: FeedbackType.BUG, createdAt: ago(0, 1000) },
      { status: FeedbackStatus.Closed, type: FeedbackType.THUMBS_DOWN, createdAt: ago(0, 5000) },
      { status: FeedbackStatus.InProgress, type: FeedbackType.THUMBS_DOWN, createdAt: ago(3) },
      { status: FeedbackStatus.Closed, type: FeedbackType.THUMBS_UP, createdAt: ago(6, 1) },
      { status: FeedbackStatus.New, createdAt: ago(1, 1) },
      { status: FeedbackStatus.Closed, type: FeedbackType.THUMBS_DOWN, createdAt: ago(8) },
      { status: FeedbackStatus.Closed, type: FeedbackType.FEEDBACK, createdAt: ago(10) },
      { status: FeedbackStatus.Closed, type: FeedbackType.FEEDBACK, createdAt: ago(12) },
      { status: FeedbackStatus.Closed, type: FeedbackType.THUMBS_DOWN, createdAt: ago(29, DAY_MS - 1) },
      // Outside every window.
      { status: FeedbackStatus.New, type: FeedbackType.BUG, createdAt: ago(30) },
      { status: FeedbackStatus.New, type: FeedbackType.BUG, createdAt: ago(45) },
    ]);

    const trends = await computeFeedbackTrends(now);

    expect(trends.open).toBe(
      await TestFeedback.model.countDocuments({ status: { $in: [FeedbackStatus.New, FeedbackStatus.InProgress] } })
    );
    expect(trends.open).toBe(5);

    expect(trends.receivedLast24h).toBe(await listCount('24h'));
    expect(trends.receivedLast24h).toBe(2);

    expect(trends.thumbsDownShare.current).toEqual({
      thumbsDown: await listCount('7d', [FeedbackType.THUMBS_DOWN]),
      total: await listCount('7d'),
    });
    expect(trends.thumbsDownShare.current).toEqual({ thumbsDown: 2, total: 5 });
    expect(trends.thumbsDownShare.prior).toEqual({ thumbsDown: 1, total: 3 });

    expect(trends.daily).toHaveLength(30);
    expect(trends.receivedLast30d).toBe(await listCount('30d'));
    expect(trends.receivedLast30d).toBe(9);
    for (const type of Object.values(FeedbackType)) {
      expect(trends.daily.reduce((sum, day) => sum + day[type], 0)).toBe(await listCount('30d', [type]));
    }
    // The untyped report from just over a day ago is the second-newest day's Feedback.
    expect(trends.daily[28][FeedbackType.FEEDBACK]).toBe(1);
    expect(trends.daily[0][FeedbackType.THUMBS_DOWN]).toBe(1);
    expect(trends.asOf).toBe(now.toISOString());
  });
});

describe('buildFeedbackTrends', () => {
  it('counts a report dated just ahead of the clock in the latest day', () => {
    const trends = buildFeedbackTrends(0, [{ daysAgo: -1, type: FeedbackType.BUG, count: 2 }], now);
    expect(trends.receivedLast24h).toBe(2);
    expect(trends.daily[29][FeedbackType.BUG]).toBe(2);
    expect(trends.thumbsDownShare.current).toEqual({ thumbsDown: 0, total: 2 });
  });

  it('keeps an unknown legacy type in the totals but out of every type series', () => {
    const trends = buildFeedbackTrends(0, [{ daysAgo: 2, type: 'CS', count: 3 }], now);
    expect(trends.thumbsDownShare.current.total).toBe(3);
    expect(trends.receivedLast30d).toBe(3);
    expect(trends.daily.every(day => sumFeedbackTypeCounts(day) === 0)).toBe(true);
  });
});
