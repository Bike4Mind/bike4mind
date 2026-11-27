import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { RevenueSnapshotModel, User, mongoose, revenueSnapshotRepository } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { computeRevenueSnapshot } from '@bike4mind/server-utils/admin/revenue/revenueSnapshot';
import { adminRevenue } from './adminRevenue';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-10-30T00:15:00Z');
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await RevenueSnapshotModel.syncIndexes();
});

afterEach(async () => {
  await Promise.all([Subscription.deleteMany({}), User.deleteMany({}), RevenueSnapshotModel.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

let counter = 0;

const seed = (fields: Record<string, unknown> = {}) =>
  Subscription.create({
    subscriptionId: `sub_${++counter}`,
    ownerType: 'User',
    ownerId: `owner${counter}`,
    priceId: 'price_e2e_solo',
    status: 'active',
    source: 'stripe',
    quantity: 1,
    unitAmount: 1900,
    currency: 'usd',
    interval: 'month',
    intervalCount: 1,
    periodStartsAt: new Date(NOW.getTime() - 10 * DAY_MS),
    periodEndsAt: new Date(NOW.getTime() + 20 * DAY_MS),
    createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    ...fields,
  });

describe('adminRevenue', () => {
  it('says when the trend starts before any snapshot, with current numbers still filled in', async () => {
    await seed();
    const revenue = await adminRevenue('30d', NOW);
    expect(revenue.trend).toEqual([]);
    expect(revenue.startOfRange).toBeNull();
    expect(revenue.trendStartsOn).toBe('2026-10-30');
    expect(revenue.current.mrr.amount).toBe(1900);
    expect(revenue.current.arr).toBe(22800);
  });

  it('charts the snapshots in the range and compares against the first one', async () => {
    await seed();
    await revenueSnapshotRepository.upsertSnapshot({
      ...(await computeRevenueSnapshot('2026-09-01', NOW)),
      payingCount: 9,
    });
    await revenueSnapshotRepository.upsertSnapshot(await computeRevenueSnapshot('2026-10-20', NOW));
    await revenueSnapshotRepository.upsertSnapshot(await computeRevenueSnapshot('2026-10-25', NOW));

    const revenue = await adminRevenue('30d', NOW);
    expect(revenue.from).toBe('2026-10-01');
    expect(revenue.trend.map(point => point.date)).toEqual(['2026-10-20', '2026-10-25']);
    expect(revenue.startOfRange).toMatchObject({ date: '2026-10-20', mrr: 1900, payingCount: 1 });
    expect(revenue.trendStartsOn).toBe('2026-09-01');
    expect(revenue.trend[1]).toMatchObject({
      payingUsers: 1,
      payingOrgs: 0,
      pastDueMrr: 0,
      cancelingMrr: 0,
      mrrByPlan: { price_e2e_solo: 1900 },
    });
    expect(revenue.trendPlans).toEqual([
      { key: 'price_e2e_solo', plan: { priceId: 'price_e2e_solo', name: null, interval: null } },
    ]);
  });

  it('lists past due and canceling rows largest first and shares MRR by plan', async () => {
    const user = await User.create({ name: 'ada', username: 'ada', email: 'ada@example.com' });
    await seed();
    await seed({ status: 'past_due', unitAmount: 900, ownerId: String(user._id) });
    await seed({ canceledAt: new Date(NOW.getTime() - DAY_MS), unitAmount: 4900 });
    await seed({ status: 'past_due', unitAmount: null });

    const revenue = await adminRevenue('30d', NOW);
    expect(revenue.atRisk.total).toBe(3);
    expect(revenue.atRisk.mrr).toEqual({ currency: 'usd', amount: 5800, unpriced: 1, otherCurrency: 0 });
    expect(revenue.atRisk.rows.map(row => row.mrr?.amount ?? null)).toEqual([4900, 900, null]);
    expect(revenue.atRisk.rows[1].owner).toMatchObject({ kind: 'User', email: 'ada@example.com' });
    expect(revenue.byPlan).toEqual([
      {
        plan: { priceId: 'price_e2e_solo', name: null, interval: null },
        subscriptions: 4,
        mrr: { currency: 'usd', amount: 7700, unpriced: 1, otherCurrency: 0 },
        share: 1,
      },
    ]);
  });
});
