import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  TERMINAL_SUBSCRIPTION_STATUSES,
  isCancellableSubscriptionStatus,
  isDelinquentSubscriptionStatus,
  pickDisplayedSubscription,
  pickSubscriptionByPrice,
} from './types';

// Every status Stripe can report on a subscription, so the partition below covers
// the whole domain the UI filters run over.
const ALL_STATUSES: Stripe.Subscription.Status[] = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'canceled',
  'paused',
];

// Spelled out rather than derived from isCancellableSubscriptionStatus: generating the
// cases from the function under test means moving a status into the terminal set only
// drops cases, it never fails one.
const CANCELLABLE_STATUSES: Stripe.Subscription.Status[] = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'paused',
];

describe('subscription status predicates', () => {
  it.each(CANCELLABLE_STATUSES)('treats %s as cancellable, so the user can still stop it', status => {
    expect(isCancellableSubscriptionStatus(status)).toBe(true);
  });

  it('leaves exactly the terminal statuses uncancellable', () => {
    // A status Stripe adds later must fall on the cancellable side: reaching Stripe
    // and getting a real error beats a silent 400 for a user who wants out.
    expect(ALL_STATUSES.filter(status => !isCancellableSubscriptionStatus(status)).sort()).toEqual([
      'canceled',
      'incomplete_expired',
    ]);
  });

  it.each(['past_due', 'unpaid', 'incomplete'] as const)('treats %s as delinquent', status => {
    expect(isDelinquentSubscriptionStatus(status)).toBe(true);
  });

  it.each(['active', 'trialing', 'canceled', 'incomplete_expired', 'paused'] as const)(
    'does not treat %s as delinquent',
    status => {
      expect(isDelinquentSubscriptionStatus(status)).toBe(false);
    }
  );

  it('never marks a delinquent status terminal, or the cancel affordance would hide it', () => {
    for (const status of ALL_STATUSES) {
      if (isDelinquentSubscriptionStatus(status)) {
        expect(TERMINAL_SUBSCRIPTION_STATUSES.has(status)).toBe(false);
      }
    }
  });
});

describe('pickDisplayedSubscription', () => {
  const row = (status: Stripe.Subscription.Status, subscriptionId: string) => ({ status, subscriptionId });

  it('prefers the active row over a stale non-terminal one regardless of order', () => {
    // /api/subscriptions/own is an unsorted find, so the leftover delinquent row from a
    // failed renewal can arrive first. Showing it would label the user's current plan
    // with the old row's name, price and renewal date.
    const stale = row('past_due', 'sub_stale');
    const live = row('active', 'sub_live');

    expect(pickDisplayedSubscription([stale, live])?.subscriptionId).toBe('sub_live');
    expect(pickDisplayedSubscription([live, stale])?.subscriptionId).toBe('sub_live');
  });

  it('falls back to a non-terminal row when the user has no active one', () => {
    expect(pickDisplayedSubscription([row('past_due', 'sub_dunned')])?.subscriptionId).toBe('sub_dunned');
  });

  it('ignores terminal rows, so a finished plan is not shown as current', () => {
    expect(pickDisplayedSubscription([row('canceled', 'sub_dead')])).toBeUndefined();
    expect(pickDisplayedSubscription([row('incomplete_expired', 'sub_dead')])).toBeUndefined();
  });
});

describe('pickSubscriptionByPrice', () => {
  const row = (status: Stripe.Subscription.Status, priceId: string, subscriptionId: string) => ({
    status,
    priceId,
    subscriptionId,
  });

  it('prefers the active row at that price over a stale delinquent one regardless of order', () => {
    // Nothing blocks a second checkout while the first row is past_due, and
    // /api/subscriptions/own does not sort, so the stale row can arrive first.
    const stale = row('past_due', 'price_pro', 'sub_stale');
    const live = row('active', 'price_pro', 'sub_live');

    expect(pickSubscriptionByPrice([stale, live], 'price_pro')?.subscriptionId).toBe('sub_live');
    expect(pickSubscriptionByPrice([live, stale], 'price_pro')?.subscriptionId).toBe('sub_live');
  });

  it('falls back to a non-terminal row at that price when there is no active one', () => {
    expect(pickSubscriptionByPrice([row('past_due', 'price_pro', 'sub_dunned')], 'price_pro')?.subscriptionId).toBe(
      'sub_dunned'
    );
  });

  it('ignores rows at another price', () => {
    expect(pickSubscriptionByPrice([row('active', 'price_other', 'sub_other')], 'price_pro')).toBeUndefined();
  });

  it('ignores terminal rows at that price', () => {
    expect(pickSubscriptionByPrice([row('canceled', 'price_pro', 'sub_dead')], 'price_pro')).toBeUndefined();
  });
});
