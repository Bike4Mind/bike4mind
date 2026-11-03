import type Stripe from 'stripe';
import type { ISubscription } from './types';

export type SubscriptionStripeMirror = Required<
  Pick<
    ISubscription,
    | 'unitAmount'
    | 'currency'
    | 'interval'
    | 'intervalCount'
    | 'cancelAtPeriodEnd'
    | 'cancelAt'
    | 'trialEndsAt'
    | 'stripeCustomerId'
    | 'lastSyncedAt'
  >
>;

/**
 * The slice of a Stripe subscription the mirror reads. Structural rather than `Stripe.Subscription`
 * so a caller holding another installed copy of `stripe` (packages/scripts resolves one against a
 * different @types/node) can pass its own object.
 */
export type StripeSubscriptionMirrorSource = Pick<
  Stripe.Subscription,
  'currency' | 'cancel_at_period_end' | 'cancel_at' | 'trial_end'
> & {
  customer: string | { id: string };
  items: {
    data: ReadonlyArray<{
      price: Pick<Stripe.Price, 'unit_amount' | 'currency'> & {
        currency_options?: { [currency: string]: { unit_amount: number | null } };
        recurring: Pick<Stripe.Price.Recurring, 'interval' | 'interval_count'> | null;
      };
    }>;
  };
};

type MirrorPrice = StripeSubscriptionMirrorSource['items']['data'][number]['price'];

const fromUnix = (seconds: number | null): Date | null => (seconds ? new Date(seconds * 1000) : null);

// A multi-currency price reports its default currency and amount; the subscription's currency is
// what Stripe bills. currency_options is only on the object when the caller expanded it.
const unitAmountIn = (price: MirrorPrice, currency: string): number | null =>
  price.currency === currency ? price.unit_amount : (price.currency_options?.[currency]?.unit_amount ?? null);

/**
 * The Subscription mirror fields projected from a Stripe subscription. Every path that syncs a row
 * from a Stripe subscription object spreads this in, so list rows, counts and MRR read from Mongo
 * alone (see docs/admin-subscriptions-spec.md section 6.1). Those paths: the create and admin-grant
 * flip in apps/workers/src/lib/userSubscriptions/serverUtils.ts, the customer.subscription.updated
 * worker, the customer.subscription.deleted branch of pages/api/stripe/webhook.ts, and the backfill
 * in packages/scripts. Writers holding no subscription object (markPastDue, setSeats) leave the
 * mirror alone; the customer.subscription.updated that follows them re-syncs it.
 *
 * `syncedAt` defaults to now; pass the time of the Stripe read when the write may land later.
 */
export const stripeMirrorFields = (
  subscription: StripeSubscriptionMirrorSource,
  syncedAt: Date = new Date()
): SubscriptionStripeMirror => {
  // Our plans are single-item subscriptions; every write path reads the same first item.
  const price = subscription.items.data[0]?.price;
  return {
    unitAmount: price ? unitAmountIn(price, subscription.currency) : null,
    currency: subscription.currency,
    interval: price?.recurring?.interval ?? null,
    intervalCount: price?.recurring?.interval_count ?? null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: fromUnix(subscription.cancel_at),
    trialEndsAt: fromUnix(subscription.trial_end),
    stripeCustomerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    lastSyncedAt: syncedAt,
  };
};
