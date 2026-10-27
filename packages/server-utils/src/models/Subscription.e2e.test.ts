import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type Stripe from 'stripe';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { mongoose } from '@bike4mind/database';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
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
  ownerType: SubscriptionOwnerType;
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

describe('subscription acquisition', () => {
  it('persists touches and includes them in the admin owner-details projection', async () => {
    const acquisition = { firstTouch: { source: 'widgets' }, lastTouch: { source: 'email', medium: 'newsletter' } };
    await Subscription.create({ ...row(), acquisition });

    const result = await subscriptionRepository.findWithOwnerDetails();

    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0].acquisition).toEqual(acquisition);
  });
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

/**
 * Real-query guard for the org display/duplicate-guard read. The route, the billing
 * section and the webhook guard all mock the repository, so reverting this to the
 * active-only predicate would leave every one of those suites green - only a real
 * `find` against a real collection pins it.
 */
describe('findNonTerminalSubscriptionsByOwner', () => {
  const orgRow = (overrides: RowOverrides = {}) =>
    row({ ownerType: SubscriptionOwnerType.Organization, ownerId: 'org_1', ...overrides });

  it('returns a past_due org row, which the active-only lookup hides', async () => {
    await Subscription.create(orgRow({ status: 'past_due' }));

    const found = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      'org_1'
    );

    expect(found.map(s => s.status)).toEqual(['past_due']);
    // The whole point: the two reads diverge on this row, so the org has a billing
    // screen to act on while entitlement checks still see nothing.
    expect(
      await subscriptionRepository.findActiveSubscriptionsByOwner(SubscriptionOwnerType.Organization, 'org_1')
    ).toEqual([]);
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'] as const)(
    'returns a %s row',
    async status => {
      await Subscription.create(orgRow({ status }));

      const found = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
        SubscriptionOwnerType.Organization,
        'org_1'
      );

      expect(found.map(s => s.status)).toEqual([status]);
    }
  );

  // Spelled out rather than derived from TERMINAL_SUBSCRIPTION_STATUSES: generating the
  // cases from the set under test means narrowing it only drops cases, never fails one.
  it.each(['canceled', 'incomplete_expired'] as const)('excludes a %s row', async status => {
    await Subscription.create(orgRow({ status }));

    const found = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      'org_1'
    );

    expect(found).toEqual([]);
  });

  it('still returns the live row for a canceled-then-resubscribed org, so it is not locked out', async () => {
    await Subscription.create(orgRow({ status: 'canceled', subscriptionId: 'sub_old' }));
    await Subscription.create(orgRow({ status: 'active', subscriptionId: 'sub_new' }));

    const found = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      'org_1'
    );

    expect(found.map(s => s.subscriptionId)).toEqual(['sub_new']);
  });

  it('does not match another owner or another owner type', async () => {
    await Subscription.create(orgRow({ ownerId: 'org_2', status: 'past_due' }));
    await Subscription.create(row({ ownerId: 'org_1', status: 'past_due' }));

    const found = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      'org_1'
    );

    expect(found).toEqual([]);
  });
});

// The once-per-invoice guarantee for payment-failed emails rests on these conditional updates,
// which the notice service's unit suite mocks out.
describe('payment failure notice claims', () => {
  it('lets exactly one caller claim an invoice, and claims a new invoice again', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_claim' }));

    const first = await Promise.all([
      subscriptionRepository.claimPaymentFailureNotice('sub_claim', 'in_1'),
      subscriptionRepository.claimPaymentFailureNotice('sub_claim', 'in_1'),
    ]);
    expect(first.filter(Boolean)).toHaveLength(1);
    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_claim', 'in_1')).toBe(false);

    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_claim', 'in_2')).toBe(true);
  });

  it('releases a claim so the same invoice can be claimed again', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_release' }));
    await subscriptionRepository.claimPaymentFailureNotice('sub_release', 'in_1');

    await subscriptionRepository.releasePaymentFailureNotice('sub_release', 'in_1');

    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_release', 'in_1')).toBe(true);
  });

  it('does not release a newer invoice when releasing an older one', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_newer' }));
    await subscriptionRepository.claimPaymentFailureNotice('sub_newer', 'in_1');
    await subscriptionRepository.claimPaymentFailureNotice('sub_newer', 'in_2');

    await subscriptionRepository.releasePaymentFailureNotice('sub_newer', 'in_1');

    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_newer', 'in_2')).toBe(false);
  });

  it('keeps an older invoice claimed when a newer one fails, so retries of either stay silent', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_two' }));
    await subscriptionRepository.claimPaymentFailureNotice('sub_two', 'in_1');
    await subscriptionRepository.claimPaymentFailureNotice('sub_two', 'in_2');

    // A late redelivery or retry for the older invoice arrives after the newer one was claimed.
    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_two', 'in_1')).toBe(false);
    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_two', 'in_2')).toBe(false);
  });

  it('caps the remembered invoices, dropping the oldest', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_cap' }));
    for (let i = 0; i < 13; i++) {
      await subscriptionRepository.claimPaymentFailureNotice('sub_cap', `in_${i}`);
    }

    const stored = await Subscription.findOne({ subscriptionId: 'sub_cap' }).lean<{
      paymentFailureNotifiedInvoiceIds: string[];
    }>();
    expect(stored?.paymentFailureNotifiedInvoiceIds).toHaveLength(12);
    expect(stored?.paymentFailureNotifiedInvoiceIds[0]).toBe('in_1');
  });

  it('claims the cancellation notice once, and again after a release', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_cancel' }));

    expect(await subscriptionRepository.claimNonPaymentCancelNotice('sub_cancel')).toBe(true);
    expect(await subscriptionRepository.claimNonPaymentCancelNotice('sub_cancel')).toBe(false);

    await subscriptionRepository.releaseNonPaymentCancelNotice('sub_cancel');
    expect(await subscriptionRepository.claimNonPaymentCancelNotice('sub_cancel')).toBe(true);
  });

  it('claims nothing for a subscription this stage has no row for', async () => {
    expect(await subscriptionRepository.claimPaymentFailureNotice('sub_missing', 'in_1')).toBe(false);
    expect(await subscriptionRepository.claimNonPaymentCancelNotice('sub_missing')).toBe(false);
  });
});

describe('markPastDue', () => {
  it('moves an open row to past_due', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_open' }));

    const updated = await subscriptionRepository.markPastDue('sub_open');

    expect(updated?.status).toBe('past_due');
  });

  it.each(['canceled', 'incomplete_expired'] as const)(
    'leaves a %s row alone, so a late payment failure cannot revive it',
    async status => {
      await Subscription.create(row({ subscriptionId: `sub_${status}`, status }));

      expect(await subscriptionRepository.markPastDue(`sub_${status}`)).toBeNull();
      const stored = await Subscription.findOne({ subscriptionId: `sub_${status}` }).lean<{ status: string }>();
      expect(stored?.status).toBe(status);
    }
  );

  it('returns null when this stage has no row', async () => {
    expect(await subscriptionRepository.markPastDue('sub_missing')).toBeNull();
  });
});

describe('updateByStripeSubscriptionIdReturningBefore', () => {
  it('writes the update and resolves to the row as it was before it', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_swap', priceId: 'price_basic' }));

    const before = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore('sub_swap', {
      priceId: 'price_pro',
      canceledAt: new Date('2026-01-15T00:00:00Z'),
    });

    expect(before).toMatchObject({ priceId: 'price_basic', canceledAt: null });
    const stored = await Subscription.findOne({ subscriptionId: 'sub_swap' }).lean<{ priceId: string }>();
    expect(stored?.priceId).toBe('price_pro');
  });

  it('gives each of two successive writes the state the other left', async () => {
    await Subscription.create(row({ subscriptionId: 'sub_seq', priceId: 'price_basic' }));

    const first = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore('sub_seq', {
      priceId: 'price_pro',
    });
    const second = await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore('sub_seq', {
      priceId: 'price_team',
    });

    expect([first?.priceId, second?.priceId]).toEqual(['price_basic', 'price_pro']);
  });

  it('returns null, and writes nothing, when this stage has no row or the id is missing', async () => {
    expect(
      await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore('sub_missing', { priceId: 'p' })
    ).toBeNull();
    await Subscription.create(row({ subscriptionId: 'sub_other' }));
    expect(await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore('', { priceId: 'p' })).toBeNull();
    const stored = await Subscription.findOne({ subscriptionId: 'sub_other' }).lean<{ priceId: string }>();
    expect(stored?.priceId).toBe('price_pro');
  });
});

/** Real-query guard for the org-seat read: every resolver that mocks the repository would stay green without it. */
describe('findActiveSubscriptionsByOwners', () => {
  const Org = SubscriptionOwnerType.Organization;

  it('returns only active rows of the given owners of the given owner type', async () => {
    await Subscription.create([
      row({ ownerType: Org, ownerId: 'org_a', subscriptionId: 'sub_a' }),
      row({ ownerType: Org, ownerId: 'org_b', subscriptionId: 'sub_b' }),
      row({ ownerType: Org, ownerId: 'org_a', subscriptionId: 'sub_a_lapsed', status: 'canceled' }),
      row({ ownerType: Org, ownerId: 'org_b', subscriptionId: 'sub_b_dunning', status: 'past_due' }),
      row({ ownerType: Org, ownerId: 'org_other', subscriptionId: 'sub_other' }),
      // Same id string under the other owner type must not leak in.
      row({ ownerType: SubscriptionOwnerType.User, ownerId: 'org_a', subscriptionId: 'sub_user' }),
    ]);

    const rows = await subscriptionRepository.findActiveSubscriptionsByOwners(Org, ['org_a', 'org_b']);

    expect(rows.map(r => r.subscriptionId).sort()).toEqual(['sub_a', 'sub_b']);
  });

  it('returns nothing for an empty owner list', async () => {
    await Subscription.create(row({ ownerType: Org, ownerId: 'org_a' }));

    await expect(subscriptionRepository.findActiveSubscriptionsByOwners(Org, [])).resolves.toEqual([]);
  });
});
