import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import {
  backfillSubscriptionStripeMirror,
  retrieveFromStripe,
  type RetrieveStripeSubscription,
} from './backfillSubscriptionStripeMirror';

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
    cancel_at: id === 'sub_canceling' ? 1798761600 : null,
    trial_end: null,
    items: {
      data: [{ price: { unit_amount: 2000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }],
    },
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

    expect(result).toEqual({ scanned: 3, updated: 2, skippedNewer: 0, missingInStripe: 1, failed: 0 });
    const row = await subscriptions().findOne({ subscriptionId: 'sub_canceling' });
    expect(row).toMatchObject({
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
      intervalCount: 1,
      cancelAtPeriodEnd: true,
      cancelAt: new Date('2027-01-01T00:00:00Z'),
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
    expect(result).toEqual({ scanned: 1, updated: 0, skippedNewer: 0, missingInStripe: 1, failed: 0 });
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

    expect(result).toEqual({ scanned: 3, updated: 1, skippedNewer: 0, missingInStripe: 1, failed: 1 });
    expect(await subscriptions().findOne({ subscriptionId: 'sub_new' })).not.toHaveProperty('lastSyncedAt');
  });

  // Stamped before this run's own clock, as by a webhook on a host running behind: only a
  // compare-and-set on the scanned value, not a time comparison, recognizes it as newer.
  const WEBHOOK_SYNCED_AT = new Date(SYNCED_EARLIER.getTime() + 60_000);

  it.each([
    { resync: false, subscriptionId: 'sub_new' },
    { resync: true, subscriptionId: 'sub_new' },
    { resync: true, subscriptionId: 'sub_synced' },
  ])(
    'keeps a sync written after the scan read the row (resync: $resync, $subscriptionId)',
    async ({ resync, subscriptionId }) => {
      const retrieve: RetrieveStripeSubscription = async id => {
        const stale = stripeSubscription(id);
        if (id === subscriptionId) {
          await subscriptions().updateOne(
            { subscriptionId: id },
            { $set: { cancelAtPeriodEnd: true, lastSyncedAt: WEBHOOK_SYNCED_AT } }
          );
        }
        return stale;
      };

      const result = await run({ retrieve, resync });

      expect(result.skippedNewer).toBe(1);
      expect(await subscriptions().findOne({ subscriptionId })).toMatchObject({
        cancelAtPeriodEnd: true,
        lastSyncedAt: WEBHOOK_SYNCED_AT,
      });
    }
  );

  it('writes a row unchanged since the scan, even when its lastSyncedAt is ahead of this clock', async () => {
    const aheadOfThisClock = new Date(Date.now() + 60 * 60_000);
    await subscriptions().updateOne({ subscriptionId: 'sub_synced' }, { $set: { lastSyncedAt: aheadOfThisClock } });

    const result = await run({ resync: true });

    expect(result.skippedNewer).toBe(0);
    const row = await subscriptions().findOne({ subscriptionId: 'sub_synced' });
    expect(row).toMatchObject({ unitAmount: 2000 });
    expect(row?.lastSyncedAt).not.toEqual(aheadOfThisClock);
  });
});

describe('retrieveFromStripe', () => {
  const stripeError = (code: string) =>
    new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', code, message: code });
  const failingWith = (error: Error) => ({ subscriptions: { retrieve: () => Promise.reject(error) } });

  it('maps a missing subscription to null', async () => {
    await expect(retrieveFromStripe(failingWith(stripeError('resource_missing')))('sub_x')).resolves.toBeNull();
  });

  it('rethrows any other error so the row counts as failed', async () => {
    await expect(retrieveFromStripe(failingWith(stripeError('parameter_invalid')))('sub_x')).rejects.toThrow(
      'parameter_invalid'
    );
    await expect(retrieveFromStripe(failingWith(new Error('network')))('sub_x')).rejects.toThrow('network');
  });

  it('returns the subscription Stripe has', async () => {
    const subscription = stripeSubscription('sub_new');
    const reader = { subscriptions: { retrieve: () => Promise.resolve(subscription) } };
    await expect(retrieveFromStripe(reader)('sub_new')).resolves.toBe(subscription);
  });
});
