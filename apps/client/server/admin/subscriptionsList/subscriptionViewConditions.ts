import {
  DELINQUENT_SUBSCRIPTION_STATUSES,
  SubscriptionSource,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  CHURNED_WINDOW_MS,
  type AdminSubscriptionsFilter,
  type AdminSubscriptionsSummary,
} from '@client/app/utils/adminSubscriptionsFilter';

// Kept apart from the plan catalog so apps/workers can share these without loading checkout's price constants.

type Condition = Record<string, unknown>;

const TERMINAL = [...TERMINAL_SUBSCRIPTION_STATUSES];
const DELINQUENT = [...DELINQUENT_SUBSCRIPTION_STATUSES];

// Stripe's canceled_at, stored verbatim on the row, is set when a cancel is requested; the Stripe
// subscription-updated handler in apps/workers reads a pending cancel the same way.
export function cancelCondition(cancel: NonNullable<AdminSubscriptionsFilter['cancel']>, now: Date): Condition {
  if (cancel === 'scheduled') return { status: { $nin: TERMINAL }, canceledAt: { $ne: null } };
  return { canceledAt: { $gte: new Date(now.getTime() - CHURNED_WINDOW_MS) } };
}

/**
 * The built-in views' conditions. Must stay in sync with the views table in
 * docs/admin-subscriptions-spec.md section 5.1 and the list page's view definitions.
 */
export function viewConditions(now: Date): Record<keyof AdminSubscriptionsSummary['views'], Condition> {
  return {
    paying: { source: SubscriptionSource.Stripe, status: { $in: ['active', 'past_due'] } },
    pastDue: { status: { $in: DELINQUENT } },
    comped: { source: SubscriptionSource.AdminGrant, status: { $nin: TERMINAL } },
    churned: { status: 'canceled', canceledAt: { $gte: new Date(now.getTime() - CHURNED_WINDOW_MS) } },
  };
}
