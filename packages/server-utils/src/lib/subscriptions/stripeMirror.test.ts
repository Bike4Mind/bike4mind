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
    cancel_at: null,
    trial_end: null,
    items: {
      data: [
        {
          price: {
            id: 'price_123',
            unit_amount: 2000,
            currency: 'usd',
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
    ...overrides,
  }) as unknown as Stripe.Subscription;

describe('stripeMirrorFields', () => {
  it('projects price, currency, interval, cancel state and customer', () => {
    expect(stripeMirrorFields(makeSubscription(), SYNCED_AT)).toEqual({
      unitAmount: 2000,
      currency: 'usd',
      interval: 'month',
      intervalCount: 1,
      cancelAtPeriodEnd: false,
      cancelAt: null,
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

  it('carries a cancel scheduled on a custom date, which leaves cancel_at_period_end false', () => {
    const mirror = stripeMirrorFields(makeSubscription({ cancel_at: 1798761600 }), SYNCED_AT);
    expect(mirror).toMatchObject({ cancelAtPeriodEnd: false, cancelAt: new Date('2027-01-01T00:00:00Z') });
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
      currency: 'eur',
      items: {
        data: [
          {
            price: {
              id: 'price_tiered',
              unit_amount: null,
              currency: 'eur',
              recurring: { interval: 'month', interval_count: 3 },
            },
          },
        ],
      } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(stripeMirrorFields(subscription, SYNCED_AT)).toMatchObject({
      unitAmount: null,
      currency: 'eur',
      interval: 'month',
      intervalCount: 3,
    });
  });

  describe('a subscription billed in a currency other than the price default', () => {
    const billedInEur = (currencyOptions?: Record<string, { unit_amount: number | null }>) =>
      makeSubscription({
        currency: 'eur',
        items: {
          data: [
            {
              price: {
                id: 'price_multi',
                unit_amount: 2000,
                currency: 'usd',
                ...(currencyOptions && { currency_options: currencyOptions }),
                recurring: { interval: 'month', interval_count: 1 },
              },
            },
          ],
        } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
      });

    it('takes the amount from the currency option for the billed currency', () => {
      const subscription = billedInEur({ usd: { unit_amount: 2000 }, eur: { unit_amount: 1800 } });
      expect(stripeMirrorFields(subscription, SYNCED_AT)).toMatchObject({ unitAmount: 1800, currency: 'eur' });
    });

    it('stores a null amount, never the default-currency one, when the options are absent', () => {
      expect(stripeMirrorFields(billedInEur(), SYNCED_AT)).toMatchObject({ unitAmount: null, currency: 'eur' });
    });

    it('stores a null amount when the options lack the billed currency', () => {
      const subscription = billedInEur({ usd: { unit_amount: 2000 } });
      expect(stripeMirrorFields(subscription, SYNCED_AT)).toMatchObject({ unitAmount: null, currency: 'eur' });
    });
  });

  it('mirrors the subscription currency and no price fields when it has no price', () => {
    const subscription = makeSubscription({
      currency: 'gbp',
      items: { data: [] } as unknown as Stripe.ApiList<Stripe.SubscriptionItem>,
    });
    expect(stripeMirrorFields(subscription, SYNCED_AT)).toMatchObject({
      unitAmount: null,
      currency: 'gbp',
      interval: null,
      intervalCount: null,
    });
  });
});
