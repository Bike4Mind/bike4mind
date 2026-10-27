import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { getSignupTimeseries } from './signupTimeseries';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-03-10T12:30:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.syncIndexes(), UserApiKey.syncIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([User.collection.deleteMany({}), UserApiKey.collection.deleteMany({})]);
});

// Raw inserts: the classifier only reads these fields, and the full User schema's required fields are
// irrelevant to the time series.
const insertUsers = (rows: { email: string; createdAt: Date; signupMeta?: Record<string, unknown> }[]) =>
  User.collection.insertMany(
    rows.map(row => {
      const _id = new mongoose.Types.ObjectId();
      return { _id, username: `u${String(_id)}`, ...row };
    })
  );

describe('getSignupTimeseries', () => {
  it('buckets hourly, splits a cadence farm from human webmail signups, and counts early API keys', async () => {
    const farm = Array.from({ length: 30 }, (_, i) => ({
      email: `zz-${100 + i}-${i}@farm.test`,
      createdAt: new Date(NOW.getTime() - 5 * HOUR + i * 138 * 1000),
    }));
    const humans = [7, 19, 41, 88, 133, 170, 260].map((minutes, i) => ({
      email: `someone${'abcdefg'[i]}@gmail.com`,
      createdAt: new Date(NOW.getTime() - minutes * MIN),
    }));
    const inserted = await insertUsers([...farm, ...humans]);
    const farmIds = Object.values(inserted.insertedIds).slice(0, farm.length);
    await UserApiKey.collection.insertMany(
      farmIds.map((id, i) => ({
        userId: String(id),
        keyPrefix: `k${i}`,
        createdAt: new Date(farm[i].createdAt.getTime() + MIN),
      }))
    );

    const result = await getSignupTimeseries({ range: '24h' }, NOW);

    expect(result.bucket).toBe('hour');
    expect(result.buckets).toHaveLength(24);
    expect(result.buckets[23].start).toBe('2026-03-10T12:00:00.000Z');
    expect(result.totals).toMatchObject({ total: 37, suspected: 30, likelyLegit: 7, unclassified: 0 });
    expect(result.totals.bySignal.domainCadence).toBe(30);
    expect(result.totals.bySignal.earlyApiKey).toBe(30);
    expect(result.truncated).toBe(false);
    for (const bucket of result.buckets)
      expect(bucket.suspected + bucket.likelyLegit + bucket.unclassified).toBe(bucket.total);
  });

  it('treats accounts without signup metadata as no signal', async () => {
    await insertUsers([{ email: 'old@company.test', createdAt: new Date(NOW.getTime() - HOUR) }]);
    const result = await getSignupTimeseries({ range: '24h' }, NOW);
    expect(result.totals).toMatchObject({ total: 1, suspected: 0, likelyLegit: 1 });
  });

  it('flags a WAF bot label from signup metadata', async () => {
    await insertUsers([
      { email: 'a@company.test', createdAt: new Date(NOW.getTime() - HOUR), signupMeta: { wafBotSignal: true } },
    ]);
    const result = await getSignupTimeseries({ range: '24h' }, NOW);
    expect(result.totals).toMatchObject({ suspected: 1, likelyLegit: 0 });
    expect(result.totals.bySignal.wafBotSignal).toBe(1);
  });

  it('buckets daily at the viewer offset and computes a trailing baseline from earlier days', async () => {
    const DAY = 24 * HOUR;
    // Two signups a day for the four weeks before the range, then a spike today.
    const history = Array.from({ length: 28 * 2 }, (_, i) => ({
      email: `p${'abcdefghij'[i % 10]}${'klmnopqrst'[Math.floor(i / 10)]}@gmail.com`,
      createdAt: new Date(NOW.getTime() - 31 * DAY + Math.floor(i / 2) * DAY + (i % 2) * HOUR),
    }));
    const spike = Array.from({ length: 9 }, (_, i) => ({
      email: `today${'abcdefghi'[i]}@gmail.com`,
      createdAt: new Date(NOW.getTime() - (i + 1) * MIN),
    }));
    await insertUsers([...history, ...spike]);

    const result = await getSignupTimeseries({ range: '30d', tzOffsetMinutes: 540 }, NOW);

    expect(result.bucket).toBe('day');
    expect(result.buckets).toHaveLength(30);
    // 12:30Z is 21:30 at +09:00, so the last bucket starts at local midnight, 15:00Z the day before.
    expect(result.buckets[29].start).toBe('2026-03-09T15:00:00.000Z');
    expect(result.buckets[29].total).toBe(9);
    expect(result.buckets[29].baseline?.median).toBeLessThanOrEqual(2);
  });

  it('reads the per-bucket counts from the createdAt index', async () => {
    const explain = (await User.aggregate([
      { $match: { createdAt: { $gte: new Date(0), $lt: NOW } } },
      { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'day' } }, count: { $sum: 1 } } },
    ])
      .hint({ createdAt: 1 })
      .explain()) as unknown;
    const plan = JSON.stringify(explain);
    expect(plan).toContain('IXSCAN');
    expect(plan).not.toContain('COLLSCAN');
  });
});
