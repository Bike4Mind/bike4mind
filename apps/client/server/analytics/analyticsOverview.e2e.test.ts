import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { AnalyticsDaily, AnalyticsUserDay, UsageEvent, User, UserApiKey } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { rollupDay } from './analyticsRollup';
import { getAnalyticsOverview } from './analyticsOverview';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongod: MongoMemoryServer;
const originalDomains = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const TODAY = '2026-06-15';

const oid = () => new mongoose.Types.ObjectId();
const users = { a: oid(), b: oid(), c: oid(), admin: oid(), fresh: oid() };

const seedUser = (id: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) =>
  mongoose.connection.collection('users').insertOne({
    _id: id,
    username: String(id),
    email: `${id}@customer.example.com`,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  });

const seedEvent = (userId: mongoose.Types.ObjectId, at: string, extra: Record<string, unknown> = {}) =>
  UsageEvent.collection.insertOne({
    requestId: String(oid()),
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
    ...extra,
  });

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await AnalyticsUserDay.createIndexes();
  await AnalyticsDaily.createIndexes();
  await User.createIndexes();
  await UserApiKey.createIndexes();
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

afterAll(async () => {
  if (originalDomains === undefined) delete process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS;
  else process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = originalDomains;
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    UsageEvent.deleteMany({}),
    AnalyticsUserDay.deleteMany({}),
    AnalyticsDaily.deleteMany({}),
    User.deleteMany({}),
    UserApiKey.deleteMany({}),
  ]);
  await seedUser(users.a);
  await seedUser(users.b);
  await seedUser(users.c);
  await seedUser(users.admin, { isAdmin: true });
  await seedUser(users.fresh, { createdAt: new Date(`${TODAY}T09:00:00Z`) });
});

describe('getAnalyticsOverview', () => {
  it('computes today live with the rollup definitions, so it matches the nightly row', async () => {
    await seedEvent(users.a, '2026-06-10T10:00:00Z');
    await seedEvent(users.b, '2026-05-25T10:00:00Z');
    for (const day of ['2026-05-25', '2026-06-10']) await rollupDay(day, { now: NOW });
    await seedEvent(users.c, `${TODAY}T08:00:00Z`, { source: 'cli' });
    await seedEvent(users.a, `${TODAY}T09:00:00Z`);
    await seedEvent(users.admin, `${TODAY}T09:30:00Z`);
    await seedEvent(users.fresh, `${TODAY}T10:00:00Z`, { source: 'system' });

    const overview = await getAnalyticsOverview({ range: '28d', compare: 'prev', signups: 'all' }, NOW);
    const today = overview.activeUsers.days.at(-1);
    expect(today).toMatchObject({ day: TODAY, partial: true, dau: 3, wau: 3, mau: 4 });
    expect(overview.activeUsers.bySource.at(-1)?.counts).toEqual({ web: 1, cli: 1 });
    expect(overview.activeUsers.days.find(day => day.day === '2026-06-10')).toMatchObject({ dau: 1, partial: false });
    expect(overview.missingDays).toHaveLength(25);

    await rollupDay(TODAY, { now: NOW });
    const nightly = await AnalyticsDaily.findOne({ day: TODAY }).lean();
    expect({ dau: today?.dau, wau: today?.wau, mau: today?.mau }).toEqual({
      dau: nightly?.dau,
      wau: nightly?.wau,
      mau: nightly?.mau,
    });
    const liveSignups = overview.signups.buckets.at(-1);
    expect({
      legit: liveSignups?.legit,
      suspected: liveSignups?.suspected,
      unclassified: liveSignups?.unclassified,
    }).toEqual({
      legit: nightly?.signups.legit,
      suspected: nightly?.signups.suspected,
      unclassified: nightly?.signups.unclassified,
    });
    expect((liveSignups?.legit ?? 0) + (liveSignups?.suspected ?? 0) + (liveSignups?.unclassified ?? 0)).toBe(1);
  });

  it('reads a past custom range from the rollup alone, without a live slice', async () => {
    await seedEvent(users.a, '2026-06-01T10:00:00Z');
    await rollupDay('2026-06-01', { now: NOW });
    await seedEvent(users.b, `${TODAY}T08:00:00Z`);

    const overview = await getAnalyticsOverview(
      { range: 'custom', from: '2026-06-01', to: '2026-06-02', compare: 'off', signups: 'legit' },
      NOW
    );
    expect(overview.window).toMatchObject({ partialDay: null, completeDays: 2, previous: null });
    expect(overview.activeUsers.days).toEqual([
      { day: '2026-06-01', dau: 1, wau: 1, mau: 1, partial: false },
      { day: '2026-06-02', dau: null, wau: null, mau: null, partial: false },
    ]);
    expect(overview.missingDays).toEqual(['2026-06-02']);
    expect(overview.lastUpdated).toBe(NOW.toISOString());
  });
});
