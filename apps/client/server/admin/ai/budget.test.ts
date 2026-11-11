import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Cache } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { AdminAiSkip } from './adminAiSkip';
import {
  adminAiDecisionAccounting,
  adminAiMonthKey,
  adminAiMonthWindowMs,
  readAdminAiSpend,
  reserveAdminAiSpend,
  type AdminAiSpendLimits,
} from './budget';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // The fixed-window claim relies on the unique key index to refuse a second live window.
  await Cache.syncIndexes();
}, MONGO_TEST_TIMEOUT_MS);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map(c => c.deleteMany({})));
});

const LIMITS: AdminAiSpendLimits = { monthlyCapUsd: 10, dailyBudgetUsd: 1, maxCallsPerDay: 10 };

const totalDocs = async () => {
  const collections = await mongoose.connection.db!.collections();
  const counts = await Promise.all(collections.map(c => c.countDocuments()));
  return counts.reduce((a, b) => a + b, 0);
};

const skipReason = (promise: Promise<unknown>) =>
  promise.then(
    () => 'reserved',
    (error: unknown) => (error instanceof AdminAiSkip ? error.reason : `threw: ${String(error)}`)
  );

const reserve = (maxCostUsd: number, limits: Partial<AdminAiSpendLimits> = {}, feature = 'feedbackTriage' as const) =>
  reserveAdminAiSpend({ feature, maxCostUsd, limits: { ...LIMITS, ...limits } });

describe('reserveAdminAiSpend', () => {
  it.each([
    ['zero monthly cap', { monthlyCapUsd: 0 }, 'budget'],
    ['zero daily budget', { dailyBudgetUsd: 0 }, 'budget'],
    ['zero call cap', { maxCallsPerDay: 0 }, 'call_cap'],
  ] as const)('%s refuses even a free call without writing anything', async (_label, limits, reason) => {
    expect(await skipReason(reserve(0, limits))).toBe(reason);
    expect(await totalDocs()).toBe(0);
  });

  it('refuses the call after the daily call cap', async () => {
    await reserve(0.01, { maxCallsPerDay: 2 });
    await reserve(0.01, { maxCallsPerDay: 2 });
    expect(await skipReason(reserve(0.01, { maxCallsPerDay: 2 }))).toBe('call_cap');
  });

  it('refuses at the daily budget and releases the call it took', async () => {
    await reserve(0.4);
    await reserve(0.4);
    expect(await skipReason(reserve(0.4))).toBe('budget');
    expect(await readAdminAiSpend('feedbackTriage')).toMatchObject({ callsToday: 2, spentTodayUsd: 0.8 });
  });

  it('shares the monthly cap across features and leaks nothing from the refused one', async () => {
    const limits = { monthlyCapUsd: 1, dailyBudgetUsd: 10 };
    await reserveAdminAiSpend({ feature: 'dlqTriage', maxCostUsd: 0.6, limits: { ...LIMITS, ...limits } });
    expect(
      await skipReason(
        reserveAdminAiSpend({ feature: 'morningBrief', maxCostUsd: 0.6, limits: { ...LIMITS, ...limits } })
      )
    ).toBe('budget');
    expect(await readAdminAiSpend('morningBrief')).toEqual({
      callsToday: 0,
      spentTodayUsd: 0,
      spentThisMonthUsd: 0.6,
    });
  });

  it('denies a hold larger than the cap', async () => {
    expect(await skipReason(reserve(1.5))).toBe('budget');
    expect(await readAdminAiSpend('feedbackTriage')).toEqual({
      callsToday: 0,
      spentTodayUsd: 0,
      spentThisMonthUsd: 0,
    });
  });

  it('settle charges the actual cost so the difference is available again, once', async () => {
    const first = await reserve(0.8);
    await first.settle(0.1);
    await first.settle(0);
    expect(await skipReason(reserve(0.8))).toBe('reserved');
    expect(await readAdminAiSpend('feedbackTriage')).toMatchObject({ spentTodayUsd: 0.9, spentThisMonthUsd: 0.9 });
  });

  it('settle never releases more than the hold, and an unknown cost keeps it', async () => {
    const over = await reserve(0.3);
    await over.settle(5);
    const unknown = await reserve(0.3);
    await unknown.settle(Number.NaN);
    expect((await readAdminAiSpend('feedbackTriage')).spentTodayUsd).toBe(0.6);
  });

  it('refund restores the call and the spend; fail keeps both', async () => {
    const refunded = await reserve(0.5);
    await refunded.refund();
    await refunded.refund();
    expect(await readAdminAiSpend('feedbackTriage')).toMatchObject({ callsToday: 0, spentTodayUsd: 0 });

    const failed = await reserve(0.5);
    await failed.fail();
    await failed.refund();
    expect(await readAdminAiSpend('feedbackTriage')).toMatchObject({ callsToday: 1, spentTodayUsd: 0.5 });
  });

  it('decision accounting settles to the provider cost, reports it, and charges no credits', async () => {
    const costs: number[] = [];
    const accounting = adminAiDecisionAccounting(
      { feature: 'abuseAssessment', limits: LIMITS, onCost: usd => costs.push(usd) },
      { warn() {}, error() {}, info() {}, debug() {} } as never
    );
    const settlement = await accounting.reserve({ decisionId: 'd1', maxCostUsd: 0.5 });
    const credits = await settlement.settle({
      decisionId: 'd1',
      provider: 'openai',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0.02,
    });
    expect(credits).toBe(0);
    expect(costs).toEqual([0.02]);
    expect((await readAdminAiSpend('abuseAssessment')).spentTodayUsd).toBe(0.02);
  });
});

describe('month window', () => {
  it('names the UTC calendar month and outlives it by an hour', () => {
    const now = new Date('2026-03-31T23:00:00Z');
    expect(adminAiMonthKey(now)).toBe('2026-03');
    expect(adminAiMonthKey(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12');
    expect(adminAiMonthWindowMs(now)).toBe(2 * 60 * 60 * 1000);
  });
});
