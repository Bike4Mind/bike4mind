import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mongoose, CreditTransaction, UsageEvent, CreditLot, User } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { EconomyQuery, EconomyReport } from '../../shared/creditEconomy';
import { readEconomyPage, readEconomyReport } from './creditEconomy';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongo: Awaited<ReturnType<typeof createMongoServer>>;
const from = new Date('2026-08-01T00:00:00Z');
const to = new Date('2026-09-01T00:00:00Z');
const now = new Date('2026-10-01T00:00:00Z');
const query = EconomyQuery.parse({ from: from.toISOString(), to: to.toISOString(), limit: 100 });
const tx = (type: string, credits: number, extra = {}) => ({
  ownerId: 'individual',
  ownerType: 'User',
  type,
  credits,
  createdAt: from,
  updatedAt: from,
  ...extra,
});

describe('credit economy read accounting', () => {
  beforeAll(async () => {
    mongo = await createMongoServer();
    await mongoose.connect(mongo.getUri(), { autoIndex: false });
    await CreditTransaction.createIndexes();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      CreditTransaction.deleteMany({}),
      UsageEvent.deleteMany({}),
      CreditLot.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  it('conserves signed flows and agrees with paginated drill-downs across transfers, refunds, expiry and unknown grants', async () => {
    await CreditTransaction.collection.insertMany([
      tx('purchase', 100, { status: 'completed', stripePaymentIntentId: 'pi_once' }),
      tx('purchase', 50, { status: 'pending' }),
      tx('subscription', 40),
      tx('generic_add', 10, { reason: 'signup_tranche' }),
      tx('generic_add', 13),
      tx('generic_add', 5, { reason: 'admin_adjustment' }),
      tx('generic_deduct', -2, { reason: 'admin_adjustment' }),
      tx('transfer_credit', -30),
      tx('received_credit', 30, { ownerId: 'org', ownerType: 'Organization' }),
      tx('completion_api_usage', -20),
      tx('generic_add', 4, { reason: 'refund' }),
      tx('generic_deduct', -3, { reason: 'credit_expiry' }),
      tx('generic_deduct', -7, { reason: 'refund_clawback', stripeRefundId: 're_once' }),
      tx('generic_add', 999, { createdAt: to }),
    ]);
    await expect(
      CreditTransaction.collection.insertOne(
        tx('purchase', 100, { status: 'completed', stripePaymentIntentId: 'pi_once' })
      )
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      CreditTransaction.collection.insertOne(
        tx('generic_deduct', -7, { reason: 'refund_clawback', stripeRefundId: 're_once' })
      )
    ).rejects.toMatchObject({ code: 11000 });
    const report = EconomyReport.parse(await readEconomyReport(query, now));
    const page = await readEconomyPage(query);
    expect(report.netMovement).toBe(140);
    expect(page.rows.reduce((sum, row) => sum + row.delta, 0)).toBe(report.netMovement);
    expect(report.transactionCount).toBe(page.total);
    expect(report.flows.find(row => row.flow === 'transfers')).toMatchObject({ credits: 0, rows: 2 });
    expect(report.flows.find(row => row.flow === 'unknown')?.credits).toBe(13);
    for (const flow of report.flows) {
      const drill = await readEconomyPage({ ...query, flow: flow.flow });
      expect(drill.total).toBe(flow.rows);
      expect(drill.rows.reduce((sum, row) => sum + row.delta, 0)).toBe(flow.credits);
    }
    const org = await readEconomyReport({ ...query, ownerType: 'Organization' }, now);
    expect(org.netMovement).toBe(30);
    expect(org.flows.find(row => row.flow === 'purchased')?.credits).toBe(0);
    expect(report.balances).toMatchObject({ opening: null, closing: null, held: null, reconciliationDifference: null });
    expect(report.cohorts).toEqual(
      [7, 30].map(days => ({
        days,
        maturePurchases: 1,
        issuedCredits: 100,
        attributablePurchases: 0,
        consumedCredits: null,
      }))
    );
  });

  it('removes write-offs proportionally, preserves missing funding and does not count reservations as consumption', async () => {
    await CreditTransaction.collection.insertOne(tx('completion_api_usage', -40));
    await UsageEvent.collection.insertMany([
      {
        ownerType: 'User',
        ownerId: 'individual',
        createdAt: from,
        creditsCharged: 30,
        writtenOffCredits: 10,
        reservedCredits: 100,
        fundingBreakdown: { purchased: 15, subscription: 9, granted: 6, unknown: 0 },
      },
      { ownerType: 'User', ownerId: 'individual', createdAt: from, creditsCharged: 10 },
      {
        ownerType: 'User',
        ownerId: 'individual',
        createdAt: from,
        creditsCharged: 5,
        fundingBreakdown: { purchased: 100, subscription: 0, granted: 0, unknown: 0 },
      },
    ]);
    await CreditLot.collection.insertMany([
      {
        ownerType: 'User',
        ownerId: 'individual',
        source: 'pack',
        amount: 100,
        consumedAssigned: 40,
        expiresAt: new Date('2027-01-01'),
      },
      {
        ownerType: 'User',
        ownerId: 'individual',
        source: 'legacy',
        amount: 10,
        consumedAssigned: 0,
        expiresAt: new Date('2027-01-01'),
      },
      {
        ownerType: 'User',
        ownerId: 'individual',
        source: 'pack',
        amount: 99,
        consumedAssigned: 99,
        settledAt: from,
        expiresAt: from,
      },
    ]);
    const report = await readEconomyReport(query, now);
    expect(report.funding.consumption).toEqual({ purchased: 10, subscription: 6, granted: 4, unknown: 15 });
    expect(report.funding.usageDebited).toBe(35);
    expect(report.funding.ledgerUsageDifference).toBe(5);
    expect(report.funding.stampedRows).toBe(1);
    expect(report.funding.currentLotRemainingEstimate).toEqual({
      purchased: 60,
      subscription: 0,
      granted: 0,
      unknown: 10,
    });
    expect(report.balances.held).toBeNull();
  });

  it('bounds queries and returns stable pages without turning unknown balances into zero', async () => {
    expect(EconomyQuery.safeParse({ ...query, from: '2020-01-01T00:00:00Z' }).success).toBe(false);
    await User.collection.insertMany([{ currentCredits: 20 }, { currentCredits: null }]);
    await CreditTransaction.collection.insertMany([tx('generic_add', 1), tx('generic_add', 2)]);
    const first = await readEconomyPage({ ...query, limit: 1 });
    const second = await readEconomyPage({ ...query, limit: 1, page: 2 });
    expect(first.rows[0].id).not.toBe(second.rows[0].id);
    const report = await readEconomyReport({ ...query, ownerType: 'User' }, now);
    expect(report.balances.currentAvailable).toBeNull();
    expect(report.balances.missingBalances).toBe(1);
  });
});
