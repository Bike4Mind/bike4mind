import type Stripe from 'stripe';
import type { ISubscription } from './types';

export type SubscriptionStripeMirror = Required<
  Pick<
    ISubscription,
    'unitAmount' | 'currency' | 'interval' | 'cancelAtPeriodEnd' | 'trialEndsAt' | 'stripeCustomerId' | 'lastSyncedAt'
  >
>;

/**
 * The slice of a Stripe subscription the mirror reads. Structural rather than `Stripe.Subscription`
 * so a caller holding another installed copy of `stripe` (packages/scripts resolves one against a
 * different @types/node) can pass its own object.
 */
export type StripeSubscriptionMirrorSource = Pick<
  Stripe.Subscription,
  'currency' | 'cancel_at_period_end' | 'trial_end'
> & {
  customer: string | { id: string };
  items: {
    data: ReadonlyArray<{
      price: Pick<Stripe.Price, 'unit_amount' | 'currency'> & {
        recurring: Pick<Stripe.Price.Recurring, 'interval'> | null;
      };
    }>;
  };
};

/**
 * The Subscription mirror fields projected from a Stripe subscription. Every path that writes a
 * Stripe-managed row spreads this in, so list rows, counts and MRR read from Mongo alone (see
 * docs/admin-subscriptions-spec.md section 6.1). The write paths: the create and admin-grant flip
 * in apps/workers/src/lib/userSubscriptions/serverUtils.ts, the customer.subscription.updated
 * worker, the customer.subscription.deleted branch of pages/api/stripe/webhook.ts, and the
 * backfill in packages/scripts.
 */
export const stripeMirrorFields = (
  subscription: StripeSubscriptionMirrorSource,
  syncedAt: Date = new Date()
): SubscriptionStripeMirror => {
  // Our plans are single-item subscriptions; every write path reads the same first item.
  const price = subscription.items.data[0]?.price;
  return {
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? subscription.currency,
    interval: price?.recurring?.interval ?? null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    lastSyncedAt: syncedAt,
  };
};
