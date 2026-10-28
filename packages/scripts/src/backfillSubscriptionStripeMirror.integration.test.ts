import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type Stripe from 'stripe';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import { backfillSubscriptionStripeMirror, type RetrieveStripeSubscription } from './backfillSubscriptionStripeMirror';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
const subscriptions = () => mongoose.connection.collection('subscriptions');
const SYNCED_EARLIER = new Date('2026-01-01T00:00:00Z');
const UPDATED_AT = new Date('2026-02-01T00:00:00Z');

const stripeSubscription = (id: string): Stripe.Subscription =>
  ({
    id,
    currency: 'usd',
    customer: `cus_${id}`,
    cancel_at_period_end: id === 'sub_canceling',
    trial_end: null,
    items: { data: [{ price: { unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } } }] },
  }) as unknown as Stripe.Subscription;

const retrieveFrom =
  (known: string[]): RetrieveStripeSubscription =>
  async id =>
    known.includes(id) ? stripeSubscription(id) : null;

const run = (overrides: Partial<Parameters<typeof backfillSubscriptionStripeMirror>[0]> = {}) =>
  backfillSubscriptionStripeMirror({
    dryRun: false,
    resync: false,
    retrieve: retrieveFrom(['sub_new', 'sub_canceling', 'sub_synced']),
    log: () => {},
    ...overrides,
  });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await subscriptions().deleteMany({});
  await subscriptions().insertMany([
    { subscriptionId: 'sub_new', source: 'stripe', updatedAt: UPDATED_AT },
    { subscriptionId: 'sub_canceling', source: 'stripe', updatedAt: UPDATED_AT },
    { subscriptionId: 'sub_synced', source: 'stripe', unitAmount: 999, lastSyncedAt: SYNCED_EARLIER },
    { subscriptionId: 'sub_gone', source: 'stripe' },
    { subscriptionId: 'admin_grant_1', source: 'admin_grant' },
  ]);
});

describe('backfillSubscriptionStripeMirror', () => {
  it('mirrors unsynced Stripe rows, leaving grants, synced rows and updatedAt alone', async () => {
    const result = await run();

    expect(result).toEqual({ scanned: 3, updated: 2, missingInStripe: 1, failed: 0 });
    const row = await subscriptions().findOne({ subscriptionId: 'sub_canceling' });
    expect(row).toMatchObject({
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
      cancelAtPeriodEnd: true,
      trialEndsAt: null,
      stripeCustomerId: 'cus_sub_canceling',
      updatedAt: UPDATED_AT,
    });
    expect(row?.lastSyncedAt).toBeInstanceOf(Date);
    expect(await subscriptions().findOne({ subscriptionId: 'sub_synced' })).toMatchObject({ unitAmount: 999 });
    expect(await subscriptions().findOne({ subscriptionId: 'admin_grant_1' })).not.toHaveProperty('unitAmount');
    expect(await subscriptions().findOne({ subscriptionId: 'sub_gone' })).not.toHaveProperty('lastSyncedAt');
  });

  it('is a no-op on a re-run once every reachable row is synced', async () => {
    await run();
    const retrieve = vi.fn(retrieveFrom(['sub_new', 'sub_canceling', 'sub_synced']));

    const result = await run({ retrieve });

    // Only the row Stripe no longer has is looked at again.
    expect(result).toEqual({ scanned: 1, updated: 0, missingInStripe: 1, failed: 0 });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('writes nothing in a dry run', async () => {
    const result = await run({ dryRun: true });

    expect(result.updated).toBe(2);
    expect(await subscriptions().countDocuments({ lastSyncedAt: { $exists: true } })).toBe(1);
  });

  it('refreshes already-synced rows with resync', async () => {
    await run({ resync: true });

    expect(await subscriptions().findOne({ subscriptionId: 'sub_synced' })).toMatchObject({ unitAmount: 2000 });
  });

  it('counts a failed Stripe read and carries on with the next row', async () => {
    const retrieve: RetrieveStripeSubscription = async id => {
      if (id === 'sub_new') throw new Error('rate limited');
      return retrieveFrom(['sub_canceling'])(id);
    };

    const result = await run({ retrieve });

    expect(result).toEqual({ scanned: 3, updated: 1, missingInStripe: 1, failed: 1 });
    expect(await subscriptions().findOne({ subscriptionId: 'sub_new' })).not.toHaveProperty('lastSyncedAt');
  });
});
