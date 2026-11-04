import { BillingMismatchModel } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mocks = vi.hoisted(() => ({ list: vi.fn(), retrieve: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => true,
  stripe: { subscriptions: { list: mocks.list, retrieve: mocks.retrieve } },
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { runSubscriptionReconciliation } from './subscriptionReconciliation';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Promise.all([Subscription.deleteMany({}), BillingMismatchModel.deleteMany({})]);
});

const DAY = 86_400_000;
const T1 = new Date('2026-11-04T06:30:00Z');
const T2 = new Date(T1.getTime() + DAY);
const PERIOD_END = 1_802_592_000;

const stripeSub = (quantity: number) => ({
  id: 'sub_e2e',
  status: 'active',
  canceled_at: null,
  currency: 'usd',
  customer: 'cus_1',
  cancel_at_period_end: false,
  cancel_at: null,
  trial_end: null,
  created: Math.floor(T1.getTime() / 1000) - 10 * 86_400,
  metadata: { stage: 'test', userId: 'user_1' },
  items: {
    data: [
      {
        price: {
          id: 'price_1',
          unit_amount: 2000,
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 1 },
        },
        current_period_start: 1_800_000_000,
        current_period_end: PERIOD_END,
        quantity,
      },
    ],
  },
});

const listing = (subs: unknown[]) => ({
  autoPagingEach: async (fn: (sub: unknown) => Promise<boolean | void>) => {
    for (const sub of subs) if ((await fn(sub)) === false) break;
  },
});

describe('subscription reconciliation findings lifecycle', () => {
  it('opens a finding, keeps its first-seen time, and resolves it once Mongo matches Stripe', async () => {
    const row = await Subscription.create({
      ownerType: 'User',
      ownerId: 'user_1',
      subscriptionId: 'sub_e2e',
      priceId: 'price_1',
      status: 'active',
      source: 'stripe',
      periodStartsAt: new Date(1_800_000_000_000),
      periodEndsAt: new Date(PERIOD_END * 1000),
      quantity: 1,
      unitAmount: 2000,
      cancelAtPeriodEnd: false,
    });
    await Subscription.collection.updateOne({ _id: row._id }, { $set: { updatedAt: new Date(T1.getTime() - DAY) } });
    mocks.list.mockReturnValue(listing([stripeSub(3)]));

    const first = await runSubscriptionReconciliation(undefined, T1);
    expect(first.newFindings).toBe(1);
    const second = await runSubscriptionReconciliation(undefined, T2);
    expect(second.newFindings).toBe(0);

    const open = await BillingMismatchModel.findOne({ stripeSubscriptionId: 'sub_e2e' }).lean();
    expect(open).toMatchObject({ status: 'open', kind: 'drift', firstSeenAt: T1, lastSeenAt: T2 });
    expect(open?.fields).toEqual([{ field: 'quantity', mongo: '1', stripe: '3' }]);

    await Subscription.collection.updateOne({ _id: row._id }, { $set: { quantity: 3 } });
    const third = await runSubscriptionReconciliation(undefined, new Date(T2.getTime() + DAY));
    expect(third.resolved).toBe(1);
    expect(await BillingMismatchModel.findOne({ stripeSubscriptionId: 'sub_e2e' }).lean()).toMatchObject({
      status: 'resolved',
      resolvedBy: 'reconciliation',
    });
  });

  it('resolves a drift finding on the run after its row and the Stripe subscription both turn canceled', async () => {
    const row = await Subscription.create({
      ownerType: 'User',
      ownerId: 'user_1',
      subscriptionId: 'sub_e2e',
      priceId: 'price_1',
      status: 'active',
      source: 'stripe',
      periodStartsAt: new Date(1_800_000_000_000),
      periodEndsAt: new Date(PERIOD_END * 1000),
      quantity: 1,
      unitAmount: 2000,
      cancelAtPeriodEnd: false,
    });
    await Subscription.collection.updateOne({ _id: row._id }, { $set: { updatedAt: new Date(T1.getTime() - DAY) } });
    mocks.list.mockReturnValue(listing([stripeSub(3)]));
    await runSubscriptionReconciliation(undefined, T1);
    expect(await BillingMismatchModel.countDocuments({ status: 'open' })).toBe(1);

    // A late webhook cancels the row; Stripe no longer lists the subscription.
    await Subscription.collection.updateOne(
      { _id: row._id },
      { $set: { status: 'canceled', updatedAt: new Date(T1.getTime() - DAY) } }
    );
    mocks.list.mockReturnValue(listing([]));
    mocks.retrieve.mockResolvedValue({ ...stripeSub(3), status: 'canceled', canceled_at: 1_800_000_000 });

    // A truncated run leaves the finding alone.
    await runSubscriptionReconciliation(undefined, T2, Date.now() - 1);
    expect(await BillingMismatchModel.countDocuments({ status: 'open' })).toBe(1);

    const result = await runSubscriptionReconciliation(undefined, T2);
    expect(result.resolved).toBe(1);
    expect(await BillingMismatchModel.findOne({ stripeSubscriptionId: 'sub_e2e' }).lean()).toMatchObject({
      status: 'resolved',
      resolvedBy: 'reconciliation',
    });
  });
});
