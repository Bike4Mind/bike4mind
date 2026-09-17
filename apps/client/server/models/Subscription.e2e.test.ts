import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type Stripe from 'stripe';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { mongoose } from '@bike4mind/database';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { Subscription, subscriptionRepository } from './Subscription';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Real-query guard for findCancelableUserSubscriptionByPriceId.
 *
 * The cancel route's own suite mocks the repository wholesale, so it cannot see this
 * query at all: reverting the deny-list to `status: 'active'` - the one change that
 * lets a past_due user stop dunning - leaves every one of those tests green. Only a
 * real `findOne` against a real collection pins it.
 */

type RowOverrides = Partial<{
  ownerId: string;
  subscriptionId: string;
  priceId: string;
  status: Stripe.Subscription.Status;
  source: string;
}>;

const row = (overrides: RowOverrides = {}) => ({
  ownerType: SubscriptionOwnerType.User,
  ownerId: 'user_1',
  subscriptionId: `sub_${Math.random().toString(36).slice(2)}`,
  priceId: 'price_pro',
  status: 'active' as Stripe.Subscription.Status,
  source: 'stripe',
  canceledAt: null,
  periodStartsAt: new Date('2026-01-01T00:00:00Z'),
  periodEndsAt: new Date('2026-02-01T00:00:00Z'),
  quantity: 1,
  ...overrides,
});

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  // Per-collection delete, NOT dropDatabase: dropping the database also drops the unique
  // subscriptionId index, and Mongoose only autoIndexes once per model per connection - so
  // every test after the first would run without it and pass either way.
  await Subscription.deleteMany({});
});

describe('findCancelableUserSubscriptionByPriceId', () => {
  it('returns a delinquent row, which the active-only lookup hid', async () => {
    await Subscription.create(row({ status: 'past_due' }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found?.status).toBe('past_due');
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete'] as const)('returns a %s row', async status => {
    await Subscription.create(row({ status }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found?.status).toBe(status);
  });

  // Spelled out rather than derived from TERMINAL_SUBSCRIPTION_STATUSES: generating the
  // cases from the set under test means narrowing it only drops cases, never fails one.
  it.each(['canceled', 'incomplete_expired'] as const)('does not return a %s row', async status => {
    await Subscription.create(row({ status }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found).toBeNull();
  });

  it('does not match another owner or another price', async () => {
    await Subscription.create(row({ ownerId: 'user_2', status: 'past_due' }));
    await Subscription.create(row({ priceId: 'price_other', status: 'past_due' }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found).toBeNull();
  });

  it('prefers the active row over a stale delinquent one at the same price', async () => {
    // A re-subscribe after a failed renewal leaves the old row behind (nothing
    // blocks the second checkout). Cancelling that one would leave the live
    // subscription billing.
    //
    // Order matters: the active row is created FIRST, so the newest-first
    // tie-break would pick the stale row and only the active-first rule passes.
    // The reverse order passed either way and pinned nothing.
    await Subscription.create(row({ status: 'active', subscriptionId: 'sub_live' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await Subscription.create(row({ status: 'unpaid', subscriptionId: 'sub_stale' }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found?.subscriptionId).toBe('sub_live');
  });

  it('breaks a tie between two non-terminal rows by newest first', async () => {
    // findOne has no ordering contract without a sort, so pin the tie-break the
    // query declares rather than leaving it to whatever plan the engine picks.
    //
    // `past_due` sorts before `unpaid` in the status index, so inserting the
    // past_due row first makes the index scan and createdAt disagree - the test
    // only passes if the sort is actually applied.
    await Subscription.create(row({ status: 'past_due', subscriptionId: 'sub_old' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await Subscription.create(row({ status: 'unpaid', subscriptionId: 'sub_new' }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found?.subscriptionId).toBe('sub_new');
  });

  it('prefers the Stripe row over an active admin grant at the same price', async () => {
    // A support agent can comp a user who is already delinquent on Stripe:
    // grant-subscription only refuses a grant when an *active* row exists, so the
    // grant lands beside the real past_due row. Returning the grant would make the
    // cancel route 400 while Stripe kept dunning the subscription.
    await Subscription.create(row({ status: 'active', source: 'admin_grant', subscriptionId: 'admin_grant_abc' }));
    await Subscription.create(row({ status: 'past_due', source: 'stripe', subscriptionId: 'sub_dunned' }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found?.subscriptionId).toBe('sub_dunned');
  });

  it('still returns an admin grant when it is the only row, so the route can reject it', async () => {
    await Subscription.create(row({ status: 'active', source: 'admin_grant', subscriptionId: 'admin_grant_abc' }));

    const found = await subscriptionRepository.findCancelableUserSubscriptionByPriceId('price_pro', 'user_1');

    expect(found?.subscriptionId).toBe('admin_grant_abc');
  });
});

/**
 * Real-query guard for findChangeableUserSubscription.
 *
 * The change route's own suite mocks the repository wholesale, so only a real
 * `find` against a real collection pins that the deny-list is applied (reverting
 * it to `status: 'active'` would re-hide a trialing/past_due caller) and that the
 * pick is the same one the UI displays as "the" plan.
 */
describe('findChangeableUserSubscription', () => {
  it.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'] as const)(
    'returns a %s row, which the active-only lookup hid',
    async status => {
      await Subscription.create(row({ status }));

      const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

      expect(found?.status).toBe(status);
    }
  );

  // Spelled out rather than derived from TERMINAL_SUBSCRIPTION_STATUSES: generating
  // the cases from the set under test means narrowing it only drops cases, never
  // fails one.
  it.each(['canceled', 'incomplete_expired'] as const)('does not return a %s row', async status => {
    await Subscription.create(row({ status }));

    const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

    expect(found).toBeNull();
  });

  it('does not match another owner', async () => {
    await Subscription.create(row({ ownerId: 'user_2', status: 'trialing' }));

    const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

    expect(found).toBeNull();
  });

  it('prefers the Stripe row over an active admin grant', async () => {
    // The displayed-row rule: an admin grant is not what Stripe is billing, so a
    // comp landing beside a real row must not become the thing the route mutates.
    await Subscription.create(row({ status: 'active', source: 'admin_grant', subscriptionId: 'admin_grant_abc' }));
    await Subscription.create(row({ status: 'past_due', source: 'stripe', subscriptionId: 'sub_dunned' }));

    const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

    expect(found?.subscriptionId).toBe('sub_dunned');
  });

  it('still returns an admin grant when it is the only row, so the route can reject it', async () => {
    await Subscription.create(row({ status: 'active', source: 'admin_grant', subscriptionId: 'admin_grant_abc' }));

    const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

    expect(found?.subscriptionId).toBe('admin_grant_abc');
  });

  it('prefers the active row over a stale delinquent one', async () => {
    // The active row is created FIRST, so the newest-first tie-break would pick the
    // stale row and only the active-first rule passes. The reverse order passed
    // either way and pinned nothing.
    await Subscription.create(row({ status: 'active', subscriptionId: 'sub_live' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await Subscription.create(row({ status: 'unpaid', subscriptionId: 'sub_stale' }));

    const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

    expect(found?.subscriptionId).toBe('sub_live');
  });

  it('breaks a tie between two non-terminal rows by newest first', async () => {
    // `past_due` sorts before `unpaid` in the status index, so inserting the
    // past_due row first makes the index scan and createdAt disagree - the test only
    // passes if the sort is actually applied.
    await Subscription.create(row({ status: 'past_due', subscriptionId: 'sub_old' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await Subscription.create(row({ status: 'unpaid', subscriptionId: 'sub_new' }));

    const found = await subscriptionRepository.findChangeableUserSubscription('user_1');

    expect(found?.subscriptionId).toBe('sub_new');
  });
});
