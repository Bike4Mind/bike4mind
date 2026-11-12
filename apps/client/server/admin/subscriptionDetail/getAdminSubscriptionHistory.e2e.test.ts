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
const ledger = (ownerId: string, ownerType: string, type: string, credits: number, createdAt: Date) =>
  CreditTransaction.collection.insertOne({ ownerId, ownerType, type, credits, createdAt, updatedAt: createdAt });

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
});
