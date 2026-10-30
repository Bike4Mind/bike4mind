import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { RevenueSnapshotModel, User, mongoose, revenueSnapshotRepository } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '@server/models/Subscription';
import { computeRevenueSnapshot } from './revenueSnapshot';
import { adminRevenue } from './adminRevenue';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-10-30T00:15:00Z');
const DAY = '2026-10-29';
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

describe('computeRevenueSnapshot', () => {
  it('applies the MRR definitions to the Subscription mirror', async () => {
    await seed();
    await seed({ unitAmount: 19000, interval: 'year' });
    await seed({ priceId: 'price_e2e_team', ownerType: 'Organization', unitAmount: 1500, quantity: 3 });
    await seed({ status: 'past_due', unitAmount: 900 });
    await seed({ canceledAt: new Date(NOW.getTime() - 5 * DAY_MS), unitAmount: 500 });
    // Counted, never summed.
    await seed({ currency: 'eur', unitAmount: 1800 });
    await seed({ unitAmount: null });
    // Not in MRR at all.
    await seed({ source: 'admin_grant', subscriptionId: 'admin_grant_x' });
    await seed({ status: 'trialing' });
    await seed({ status: 'incomplete' });

    const snapshot = await computeRevenueSnapshot(DAY, NOW);

    // 1900 + 19000 / 12 + 4500 + 900 + 500 = 9383.33
    expect(snapshot.mrr).toEqual({ amount: 9383, unpriced: 1, otherCurrency: 1 });
    expect(snapshot.payingCount).toBe(7);
    expect(snapshot.pastDueMrr).toEqual({ amount: 900, unpriced: 0, otherCurrency: 0 });
    expect(snapshot.cancelingMrr).toEqual({ amount: 500, unpriced: 0, otherCurrency: 0 });
    expect(snapshot.mrrByPlan).toEqual([
      { priceId: 'price_e2e_solo', count: 6, amount: 4883, unpriced: 1, otherCurrency: 1 },
      { priceId: 'price_e2e_team', count: 1, amount: 4500, unpriced: 0, otherCurrency: 0 },
    ]);
    expect(snapshot.mrrByOwnerType.map(entry => [entry.ownerType, entry.count])).toEqual([
      ['User', 6],
      ['Organization', 1],
    ]);
  });

  it('counts new MRR created and churned MRR ended on the day only', async () => {
    const inDay = new Date('2026-10-29T12:00:00Z');
    const dayBefore = new Date('2026-10-28T12:00:00Z');
    await seed({ createdAt: inDay });
    await seed({ createdAt: dayBefore });
    // Created on the day but already canceled: not new MRR.
    await seed({ createdAt: inDay, status: 'canceled', canceledAt: new Date('2026-10-29T13:00:00Z') });
    // A scheduled cancel requested earlier that took effect on the day.
    await seed({ status: 'canceled', canceledAt: dayBefore, cancelAt: inDay, unitAmount: 12000, interval: 'year' });
    // A scheduled cancel whose request fell on the day but that ended earlier.
    await seed({ status: 'canceled', canceledAt: inDay, cancelAt: dayBefore, unitAmount: 700 });
    // A canceled comp is not churn.
    await seed({ status: 'canceled', canceledAt: inDay, source: 'admin_grant', subscriptionId: 'admin_grant_y' });

    const snapshot = await computeRevenueSnapshot(DAY, NOW);

    expect(snapshot.newMrr).toEqual({ amount: 1900, unpriced: 0, otherCurrency: 0 });
    // 1900 (immediate cancel on the day) + 12000 / 12
    expect(snapshot.churnedMrr).toEqual({ amount: 2900, unpriced: 0, otherCurrency: 0 });
  });

  it('writes the same row again on a rerun of the day', async () => {
    await seed();
    await revenueSnapshotRepository.upsertSnapshot(await computeRevenueSnapshot(DAY, NOW));
    await seed();
    await revenueSnapshotRepository.upsertSnapshot(await computeRevenueSnapshot(DAY, NOW));

    const rows = await RevenueSnapshotModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].mrr.amount).toBe(3800);
  });
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
    expect(revenue.startOfRange).toEqual({ date: '2026-10-20', mrr: 1900, payingCount: 1 });
    expect(revenue.trendStartsOn).toBe('2026-09-01');
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
