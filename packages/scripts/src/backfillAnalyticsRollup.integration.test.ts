import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { backfillAnalyticsRollup } from './backfillAnalyticsRollup';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
const NOW = new Date('2026-06-05T04:00:00.000Z');
const silent = () => undefined;
const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();

const seedEvent = (userId: mongoose.Types.ObjectId, at: string) =>
  UsageEvent.collection.insertOne({
    requestId: String(new mongoose.Types.ObjectId()),
    userId: String(userId),
    ownerId: String(userId),
    ownerType: 'User',
    feature: 'chat',
    provider: 'p',
    model: 'gpt-4.1',
    costUsd: 0.01,
    creditsCharged: 2,
    status: 'ok',
    source: 'web',
    createdAt: new Date(at),
  });

const snapshot = async () => ({
  daily: await AnalyticsDaily.find({}, { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 }).sort({ day: 1 }).lean(),
  userDays: await AnalyticsUserDay.countDocuments({}),
});

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AnalyticsUserDay.createIndexes();
  await AnalyticsDaily.createIndexes();
  await User.createIndexes();
  await UserApiKey.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await Promise.all([
    UsageEvent.deleteMany({}),
    AnalyticsUserDay.deleteMany({}),
    AnalyticsDaily.deleteMany({}),
    User.deleteMany({}),
  ]);
  for (const id of [userA, userB]) {
    await mongoose.connection.collection('users').insertOne({
      _id: id,
      username: String(id),
      email: `${id}@customer.example.com`,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
  }
  await seedEvent(userA, '2026-06-01T10:00:00.000Z');
  await seedEvent(userB, '2026-06-01T11:00:00.000Z');
  await seedEvent(userA, '2026-06-03T10:00:00.000Z');
});

describe('backfillAnalyticsRollup', () => {
  it('writes nothing in a dry run', async () => {
    const result = await backfillAnalyticsRollup({ dryRun: true, now: NOW, log: silent });
    expect(result).toMatchObject({ from: '2026-06-01', to: '2026-06-04', processed: 4, skipped: 0 });
    expect(await AnalyticsDaily.countDocuments({})).toBe(0);
  });

  it('rolls up every day in range, including empty ones, and a re-run is a no-op', async () => {
    const first = await backfillAnalyticsRollup({ dryRun: false, now: NOW, log: silent });
    expect(first.processed).toBe(4);
    const days = await AnalyticsDaily.find({}).sort({ day: 1 }).lean();
    expect(days.map(d => [d.day, d.dau])).toEqual([
      ['2026-06-01', 2],
      ['2026-06-02', 0],
      ['2026-06-03', 1],
      ['2026-06-04', 0],
    ]);

    const before = await snapshot();
    const second = await backfillAnalyticsRollup({ dryRun: false, now: NOW, log: silent });
    expect(second).toMatchObject({ processed: 0, skipped: 4 });
    expect(await snapshot()).toEqual(before);
  });

  it('resumes after a gap, and force recomputes days that already have a row', async () => {
    await backfillAnalyticsRollup({ dryRun: false, from: '2026-06-01', to: '2026-06-02', now: NOW, log: silent });
    const resumed = await backfillAnalyticsRollup({ dryRun: false, now: NOW, log: silent });
    expect(resumed).toMatchObject({ processed: 2, skipped: 2 });

    const before = await snapshot();
    const forced = await backfillAnalyticsRollup({ dryRun: false, force: true, now: NOW, log: silent });
    expect(forced).toMatchObject({ processed: 4, skipped: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects malformed or inverted ranges', async () => {
    await expect(backfillAnalyticsRollup({ dryRun: true, from: '06/01/2026', log: silent })).rejects.toThrow('--from');
    await expect(
      backfillAnalyticsRollup({ dryRun: true, from: '2026-06-04', to: '2026-06-01', log: silent })
    ).rejects.toThrow('after');
  });
});
