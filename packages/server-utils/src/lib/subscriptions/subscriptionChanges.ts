import type Stripe from 'stripe';
import { TERMINAL_SUBSCRIPTION_STATUSES, type ISubscription } from './types';

export interface SubscriptionChanges {
  plan: { fromPriceId: string; toPriceId: string } | null;
  cancel: 'scheduled' | 'reverted' | null;
  /** The row moved into canceled. */
  ended: boolean;
}

function cancelIsPending(status: string, canceling: boolean): boolean {
  return canceling && status !== 'canceled';
}

/**
 * What one customer.subscription.updated changed, read off the row its write replaced and Stripe's
 * state after it: a move to another price, a period-end cancel being set or withdrawn, and the
 * subscription ending. The one rule for both the analytics events and the Slack posts
 * (apps/workers/src/events/stripe/customerSubscriptionUpdated.ts). A subscription that is over
 * reports `ended`, never a cancel change; its subscription_ended analytics event is
 * customer.subscription.deleted's alone (apps/client/pages/api/stripe/webhook.ts).
 */
export function detectSubscriptionChanges(
  before: Pick<ISubscription, 'priceId' | 'status' | 'canceledAt'>,
  after: Pick<Stripe.Subscription, 'items' | 'status' | 'canceled_at'>
): SubscriptionChanges {
  // Stripe never moves a subscription out of a terminal status, so a row already in one is either
  // being overwritten by an older state or re-synced after it ended: no plan move or cancel decision happened.
  if (TERMINAL_SUBSCRIPTION_STATUSES.has(before.status)) {
    return { plan: null, cancel: null, ended: false };
  }

  const toPriceId = after.items.data[0]?.price.id;
  const plan =
    toPriceId && before.priceId && toPriceId !== before.priceId ? { fromPriceId: before.priceId, toPriceId } : null;

  // Before and after are read off the same field, Stripe's canceled_at, which the row stores
  // verbatim: set when a cancel is requested, and the signal the handler's invoice cleanup also
  // acts on. Comparing it with itself, rather than the row's copy with Stripe's
  // cancel_at_period_end, means a field the two disagree on cannot fire a transition on every
  // later update; the worst a disagreement can do is miss one.
  const wasPending = cancelIsPending(before.status, before.canceledAt != null);
  const isPending = cancelIsPending(after.status, after.canceled_at != null);
  const cancel =
    wasPending !== isPending && after.status !== 'canceled' ? (isPending ? 'scheduled' : 'reverted') : null;

  const ended = before.status !== 'canceled' && after.status === 'canceled';

  return { plan, cancel, ended };
}
