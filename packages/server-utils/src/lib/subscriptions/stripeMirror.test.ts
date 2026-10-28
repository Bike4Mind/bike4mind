import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { stripeMirrorFields } from './stripeMirror';

const SYNCED_AT = new Date('2026-10-29T12:00:00Z');

const makeSubscription = (overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription =>
  ({
    id: 'sub_123',
    currency: 'usd',
    customer: 'cus_123',
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [{ price: { id: 'price_123', unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } } }],
    },
    ...overrides,
  }) as unknown as Stripe.Subscription;

describe('stripeMirrorFields', () => {
  it('projects price, currency, interval, cancel state and customer', () => {
    expect(stripeMirrorFields(makeSubscription(), SYNCED_AT)).toEqual({
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
      cancelAtPeriodEnd: false,
      trialEndsAt: null,
      stripeCustomerId: 'cus_123',
      lastSyncedAt: SYNCED_AT,
    });
  });

  it('converts trial_end from unix seconds and carries a pending cancel', () => {
    const mirror = stripeMirrorFields(
      makeSubscription({ trial_end: 1798761600, cancel_at_period_end: true }),
      SYNCED_AT
    );
    expect(mirror.trialEndsAt).toEqual(new Date('2027-01-01T00:00:00Z'));
    expect(mirror.cancelAtPeriodEnd).toBe(true);
  });

  it('reads the id from an expanded customer', () => {
    const mirror = stripeMirrorFields(
      makeSubscription({ customer: { id: 'cus_expanded' } as Stripe.Customer }),
      SYNCED_AT
    );
    expect(mirror.stripeCustomerId).toBe('cus_expanded');
  });

  it('stores a null amount for a price with no flat unit amount', () => {
    const subscription = makeSubscription({
      items: {
        data: [{ price: { id: 'price_tiered', unit_amount: null, currency: 'eur', recurring: { interval: 'year' } } }],
      } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(stripeMirrorFields(subscription, SYNCED_AT)).toMatchObject({
      unitAmount: null,
      currency: 'eur',
      interval: 'year',
    });
  });

  it('falls back to the subscription currency when it has no item', () => {
    const subscription = makeSubscription({
      currency: 'gbp',
      items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(stripeMirrorFields(subscription, SYNCED_AT)).toMatchObject({
      unitAmount: null,
      currency: 'gbp',
      interval: null,
    });
  });
});
