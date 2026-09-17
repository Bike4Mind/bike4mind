import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  TERMINAL_SUBSCRIPTION_STATUSES,
  isCancellableSubscriptionStatus,
  isDelinquentSubscriptionStatus,
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

describe('subscription status predicates', () => {
  it.each(ALL_STATUSES.filter(isCancellableSubscriptionStatus))(
    'treats %s as cancellable, so the user can still stop it',
    status => {
      expect(isCancellableSubscriptionStatus(status)).toBe(true);
    }
  );

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
