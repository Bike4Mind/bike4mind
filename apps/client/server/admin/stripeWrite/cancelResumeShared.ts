import type Stripe from 'stripe';
import type { AuditChange } from '@bike4mind/common';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import {
  SubscriptionSource,
  isCancellableSubscriptionStatus,
  resolveSubscriptionSource,
  type ISubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';

const isoOrNull = (date: Date | null | undefined) => (date ? new Date(date).toISOString() : null);

/** Shared precheck of the cancel and resume routes: a live row billed through Stripe. */
export const assertLiveStripeRow = (subscription: ISubscription): void => {
  if (resolveSubscriptionSource(subscription) !== SubscriptionSource.Stripe) {
    throw new ConflictError('Only subscriptions billed through Stripe can be changed here.');
  }
  if (!isCancellableSubscriptionStatus(subscription.status)) {
    throw new ConflictError('This subscription has already ended.');
  }
};

/** The audit changes of both routes: the cancel flag and the cancel date, before and after. */
export const cancelScheduleChanges = (before: ISubscription, after: Stripe.Subscription): AuditChange[] => [
  { field: 'cancelAtPeriodEnd', before: Boolean(before.cancelAtPeriodEnd), after: after.cancel_at_period_end },
  {
    field: 'cancelAt',
    before: isoOrNull(before.cancelAt),
    after: after.cancel_at ? new Date(after.cancel_at * 1000).toISOString() : null,
  },
];
