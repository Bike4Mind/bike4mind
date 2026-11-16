import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { BillingEventModel, CreditTransaction, mongoose } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { getAdminSubscriptionHistory } from './getAdminSubscriptionHistory';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 5, 1));
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterEach(async () => {
  await Promise.all([Subscription.deleteMany({}), CreditTransaction.deleteMany({}), BillingEventModel.deleteMany({})]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const seedSubscription = (fields: Record<string, unknown>) =>
  Subscription.create({
    subscriptionId: 'sub_hist',
    ownerType: 'Organization',
    ownerId: 'org-1',
    priceId: 'price_test',
    status: 'active',
    source: 'stripe',
    quantity: 5,
    periodStartsAt: daysAgo(10),
    periodEndsAt: daysAgo(-20),
    createdAt: daysAgo(70),
    ...fields,
  });

// Raw inserts, so the seeded createdAt is not replaced by the schema timestamps.
const ledger = (
  ownerId: string,
  ownerType: string,
  type: string,
  credits: number,
  createdAt: Date,
  metadata: Record<string, unknown> = {}
) =>
  CreditTransaction.collection.insertOne({
    ownerId,
    ownerType,
    type,
    credits,
    createdAt,
    updatedAt: createdAt,
    metadata,
  });

const billingEvent = (stripeEventId: string, type: string, quantity: number | undefined, occurredAt: Date) =>
  BillingEventModel.collection.insertOne({
    stripeEventId,
    type,
    ownerType: 'organization',
    ownerId: 'org-1',
    subscriptionId: 'sub_hist',
    amount: null,
    currency: 'usd',
    occurredAt,
    data: quantity === undefined ? {} : { quantity },
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });

describe('getAdminSubscriptionHistory', () => {
  it('returns null for an id that is not an ObjectId or names nothing', async () => {
    expect(await getAdminSubscriptionHistory('nope', NOW)).toBeNull();
    expect(await getAdminSubscriptionHistory(new mongoose.Types.ObjectId().toHexString(), NOW)).toBeNull();
  });

  it('splits the owner ledger into cycles at each plan grant and sums usage per cycle', async () => {
    const sub = await seedSubscription({});
    // Before this subscription began: an earlier plan's grant and usage, both left out.
    await ledger('org-1', 'Organization', 'subscription', 9999, daysAgo(100));
    await ledger('org-1', 'Organization', 'text_generation_usage', -7777, daysAgo(90));
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(70));
    await ledger('org-1', 'Organization', 'text_generation_usage', -300, daysAgo(60));
    await ledger('org-1', 'Organization', 'image_generation_usage', -200, daysAgo(45));
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(40));
    await ledger('org-1', 'Organization', 'text_generation_usage', -150, daysAgo(20));
    await ledger('org-1', 'Organization', 'subscription', 1200, daysAgo(10));
    await ledger('org-1', 'Organization', 'text_generation_usage', -25, daysAgo(2));
    // Not usage: a purchase and a transfer out. Another owner's usage.
    await ledger('org-1', 'Organization', 'purchase', 5000, daysAgo(5));
    await ledger('org-1', 'Organization', 'transfer_credit', -400, daysAgo(4));
    await ledger('org-2', 'Organization', 'text_generation_usage', -999, daysAgo(3));

    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);

    expect(history?.creditCyclesTruncated).toBe(false);
    expect(history?.creditUsageUnavailable).toBe(false);
    expect(history?.creditCycles).toEqual([
      { start: daysAgo(70).toISOString(), end: daysAgo(40).toISOString(), granted: 1000, used: 500, current: false },
      { start: daysAgo(40).toISOString(), end: daysAgo(10).toISOString(), granted: 1000, used: 150, current: false },
      { start: daysAgo(10).toISOString(), end: NOW.toISOString(), granted: 1200, used: 25, current: true },
    ]);
  });

  it('merges same-time grants and assigns usage on a boundary to the cycle starting there', async () => {
    const sub = await seedSubscription({});
    await ledger('org-1', 'Organization', 'subscription', 500, daysAgo(60));
    await ledger('org-1', 'Organization', 'subscription', 250, daysAgo(60));
    await ledger('org-1', 'Organization', 'text_generation_usage', -10, daysAgo(60));
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(30));
    await ledger('org-1', 'Organization', 'text_generation_usage', -20, daysAgo(30));
    await ledger('org-1', 'Organization', 'text_generation_usage', -999, NOW);

    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);

    expect(history?.creditCycles).toEqual([
      { start: daysAgo(60).toISOString(), end: daysAgo(30).toISOString(), granted: 750, used: 10, current: false },
      { start: daysAgo(30).toISOString(), end: NOW.toISOString(), granted: 1000, used: 20, current: true },
    ]);
  });

  it('ends a canceled subscription at its period end and keeps the latest cycles when there are many', async () => {
    const sub = await seedSubscription({ status: 'canceled', periodEndsAt: daysAgo(5), createdAt: daysAgo(400) });
    for (let month = 13; month >= 0; month--) {
      await ledger('org-1', 'Organization', 'subscription', 100 + month, daysAgo(5 + month * 30));
    }
    await ledger('org-1', 'Organization', 'text_generation_usage', -10, daysAgo(6));

    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);

    expect(history?.creditCyclesTruncated).toBe(true);
    expect(history?.creditCycles).toHaveLength(12);
    const last = history?.creditCycles.at(-1);
    expect(last).toMatchObject({ start: daysAgo(35).toISOString(), granted: 101, used: 10, current: false });
    // The grant on the end date opens no cycle past the end.
    expect(last?.end).toBe(daysAgo(5).toISOString());
  });

  it('reads paid-seat changes from the stored subscription events', async () => {
    const sub = await seedSubscription({});
    await billingEvent('evt_1', 'customer.subscription.created', 3, daysAgo(70));
    await billingEvent('evt_2', 'customer.subscription.updated', 3, daysAgo(60));
    await billingEvent('evt_3', 'customer.subscription.updated', 5, daysAgo(30));
    await billingEvent('evt_4', 'invoice.payment_succeeded', undefined, daysAgo(29));

    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);

    expect(history?.seatChanges).toEqual([
      { at: daysAgo(70).toISOString(), quantity: 3 },
      { at: daysAgo(30).toISOString(), quantity: 5 },
    ]);
  });

  it('has no seat history for a user row and an empty one for a comp', async () => {
    const userSub = await seedSubscription({ ownerType: 'User', ownerId: 'user-1', subscriptionId: 'sub_user' });
    const comp = await seedSubscription({ source: 'admin_grant', subscriptionId: 'admin_grant_1' });

    expect((await getAdminSubscriptionHistory(String(userSub._id), NOW))?.seatChanges).toBeNull();
    expect((await getAdminSubscriptionHistory(String(comp._id), NOW))?.seatChanges).toEqual([]);
  });
  it('folds top-ups and seat increases into plan cycles with renewal-time extras in the new cycle', async () => {
    const sub = await seedSubscription({});
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(70));
    await ledger('org-1', 'Organization', 'subscription', 5000, daysAgo(50), { source: 'admin_topup' });
    await ledger('org-1', 'Organization', 'text_generation_usage', -10, daysAgo(60));
    await ledger('org-1', 'Organization', 'text_generation_usage', -20, daysAgo(50));
    await ledger('org-1', 'Organization', 'subscription', 250, daysAgo(45), { type: 'subscription_seat_increase' });
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(40));
    await ledger('org-1', 'Organization', 'subscription', 100, daysAgo(40), { source: 'admin_topup' });
    await ledger('org-1', 'Organization', 'text_generation_usage', -30, daysAgo(40));
    await ledger('org-2', 'Organization', 'subscription', 9999, daysAgo(45), { source: 'admin_topup' });
    await ledger('org-1', 'User', 'subscription', 9999, daysAgo(45), { source: 'admin_topup' });
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCycles).toEqual([
      { start: daysAgo(70).toISOString(), end: daysAgo(40).toISOString(), granted: 6250, used: 30, current: false },
      { start: daysAgo(40).toISOString(), end: NOW.toISOString(), granted: 1100, used: 30, current: true },
    ]);
  });

  it('limits real plan boundaries before folding many extras and excludes extras older than the retained window', async () => {
    const sub = await seedSubscription({ createdAt: daysAgo(500) });
    for (let index = 13; index >= 1; index--)
      await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(index * 30));
    await ledger('org-1', 'Organization', 'subscription', 99999, daysAgo(390), { source: 'admin_topup' });
    for (let index = 1; index <= 20; index++)
      await ledger('org-1', 'Organization', 'subscription', 5, daysAgo(index), { source: 'admin_topup' });
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCyclesTruncated).toBe(true);
    expect(history?.creditCycles).toHaveLength(12);
    expect(history?.creditCycles[0]).toMatchObject({ start: daysAgo(360).toISOString(), granted: 1000 });
    expect(history?.creditCycles.at(-1)).toMatchObject({ start: daysAgo(30).toISOString(), granted: 1100 });
  });

  it('keeps exactly twelve plan cycles untruncated despite more than thirteen extras', async () => {
    const sub = await seedSubscription({ createdAt: daysAgo(500) });
    for (let index = 12; index >= 1; index--)
      await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(index * 30));
    for (let index = 1; index <= 20; index++)
      await ledger('org-1', 'Organization', 'subscription', 5, daysAgo(index), { type: 'subscription_seat_increase' });
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCyclesTruncated).toBe(false);
    expect(history?.creditCycles).toHaveLength(12);
    expect(history?.creditCycles.at(-1)?.granted).toBe(1100);
  });

  it('anchors a zero-credit comp with later extras at creation and leaves a comp without grants empty', async () => {
    const sub = await seedSubscription({ source: 'admin_grant', subscriptionId: 'admin_grant_zero' });
    expect((await getAdminSubscriptionHistory(String(sub._id), NOW))?.creditCycles).toEqual([]);
    await ledger('org-1', 'Organization', 'subscription', 500, daysAgo(10), { source: 'admin_topup' });
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCycles).toEqual([
      { start: daysAgo(70).toISOString(), end: NOW.toISOString(), granted: 500, used: 0, current: true },
    ]);
  });

  it('preserves unknown legacy and user plan grants as boundaries', async () => {
    const sub = await seedSubscription({ ownerType: 'User', ownerId: 'user-1' });
    await ledger('user-1', 'User', 'subscription', 1000, daysAgo(60));
    await ledger('user-1', 'User', 'subscription', 1500, daysAgo(30), { type: 'legacy_unknown' });
    expect((await getAdminSubscriptionHistory(String(sub._id), NOW))?.creditCycles.map(cycle => cycle.granted)).toEqual(
      [1000, 1500]
    );
  });

  it.each([
    [
      'mirrored effective end',
      { status: 'canceled', endedAt: daysAgo(20), canceledAt: daysAgo(40), cancelAtPeriodEnd: true },
      daysAgo(20),
    ],
    ['immediate cancellation', { status: 'canceled', canceledAt: daysAgo(20), cancelAtPeriodEnd: false }, daysAgo(20)],
    [
      'scheduled terminal cancellation',
      { status: 'canceled', canceledAt: daysAgo(40), cancelAtPeriodEnd: true, periodEndsAt: daysAgo(10) },
      daysAgo(10),
    ],
    [
      'custom terminal cancellation',
      { status: 'canceled', canceledAt: daysAgo(40), cancelAtPeriodEnd: false, cancelAt: daysAgo(10) },
      daysAgo(10),
    ],
    ['active scheduled cancellation', { status: 'active', canceledAt: daysAgo(40), cancelAtPeriodEnd: true }, NOW],
  ])('uses %s without counting usage on or after the effective end', async (_label, fields, end) => {
    const sub = await seedSubscription(fields);
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(60));
    await ledger('org-1', 'Organization', 'text_generation_usage', -10, daysAgo(50));
    await ledger('org-1', 'Organization', 'text_generation_usage', -20, end);
    await ledger('org-1', 'Organization', 'text_generation_usage', -30, daysAgo(-1));
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCycles).toEqual([
      {
        start: daysAgo(60).toISOString(),
        end: end.toISOString(),
        granted: 1000,
        used: 10,
        current: fields.status === 'active',
      },
    ]);
    expect(history?.creditWindowEndEstimated).toBe(false);
  });

  it('uses a historical deletion event time with matching owner instead of its later ingestion time', async () => {
    const sub = await seedSubscription({ status: 'canceled', canceledAt: daysAgo(40) });
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(60));
    await ledger('org-1', 'Organization', 'text_generation_usage', -10, daysAgo(30));
    await ledger('org-1', 'Organization', 'text_generation_usage', -100, daysAgo(20));
    await billingEvent('evt_deleted', 'customer.subscription.deleted', 5, daysAgo(20));
    await BillingEventModel.updateOne({ stripeEventId: 'evt_deleted' }, { $set: { createdAt: NOW } });
    await BillingEventModel.collection.insertOne({
      stripeEventId: 'evt_other',
      type: 'customer.subscription.deleted',
      ownerType: 'organization',
      ownerId: 'org-2',
      subscriptionId: 'sub_hist',
      occurredAt: daysAgo(1),
      data: {},
    });
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCycles[0]).toMatchObject({ end: daysAgo(20).toISOString(), used: 10 });
    expect(history?.creditWindowEndEstimated).toBe(false);
  });

  it('discloses an estimated end when legacy cancellation flags and deletion events are absent', async () => {
    const sub = await seedSubscription({ status: 'canceled', canceledAt: daysAgo(40) });
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(60));
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCycles[0]?.end).toBe(NOW.toISOString());
    expect(history?.creditWindowEndEstimated).toBe(true);
  });
  it('stops a manually ended comp at canceledAt even when its original expiry is still ahead', async () => {
    const sub = await seedSubscription({
      source: 'admin_grant',
      subscriptionId: 'admin_grant_ended',
      status: 'canceled',
      canceledAt: daysAgo(20),
    });
    await ledger('org-1', 'Organization', 'subscription', 1000, daysAgo(60), { source: 'admin_grant' });
    await ledger('org-1', 'Organization', 'text_generation_usage', -10, daysAgo(30));
    await ledger('org-1', 'Organization', 'text_generation_usage', -100, daysAgo(10));
    await ledger('org-1', 'Organization', 'subscription', 500, daysAgo(10), { source: 'admin_topup' });
    const history = await getAdminSubscriptionHistory(String(sub._id), NOW);
    expect(history?.creditCycles).toEqual([
      { start: daysAgo(60).toISOString(), end: daysAgo(20).toISOString(), granted: 1000, used: 10, current: false },
    ]);
    expect(history?.creditWindowEndEstimated).toBe(false);
  });
});
