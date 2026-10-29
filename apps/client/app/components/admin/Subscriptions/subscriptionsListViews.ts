import {
  SUBSCRIPTION_STATUS_FILTERS,
  type AdminSubscriptionsSummary,
  type SubscriptionStatusFilter,
} from '@client/app/utils/adminSubscriptionsFilter';
import { matchSavedView, type SavedViewValues } from '../shared/matchSavedView';
import {
  CLEARED_FILTER_PARAMS,
  PAYING_FILTERS,
  SUBSCRIPTIONS_FILTER_KEYS,
  type SubscriptionsListParams,
  type SubscriptionsListView,
} from './subscriptionsTabSearch';

export type SubscriptionsBuiltInView = {
  id: 'paying' | 'pastDue' | 'canceling' | 'comped' | 'churned' | 'all';
  label: string;
  /** The filters the view applies on top of a cleared filter set. */
  filters: Partial<SubscriptionsListView>;
  /** Shown when the view itself is empty: positive copy, with "View all subscriptions" as the next step. */
  empty: { title: string; description: string };
};

/** Tab counts by view: the summary's views, plus All and Canceling read off filtered summary totals. */
export type SubscriptionsViewCounts = AdminSubscriptionsSummary['views'] & { all: number; canceling: number };

const NOT_TERMINAL: SubscriptionStatusFilter[] = SUBSCRIPTION_STATUS_FILTERS.filter(
  status => status !== 'canceled' && status !== 'incomplete_expired'
);

/**
 * Must stay in sync with viewConditions in server/admin/subscriptionsList/adminSubscriptionsQuery.ts,
 * whose counts label these tabs, and with the views table in docs/admin-subscriptions-spec.md 5.1.
 */
export const SUBSCRIPTIONS_BUILT_IN_VIEWS: readonly SubscriptionsBuiltInView[] = [
  {
    id: 'paying',
    label: 'Paying',
    filters: PAYING_FILTERS,
    empty: { title: 'No paying subscriptions yet', description: 'Paid plans appear here once someone checks out.' },
  },
  {
    id: 'pastDue',
    label: 'Past due',
    filters: { status: ['past_due', 'unpaid', 'incomplete'] },
    empty: { title: 'Nobody is past due', description: 'Every Stripe renewal has gone through.' },
  },
  {
    id: 'canceling',
    label: 'Canceling',
    filters: { cancel: 'scheduled' },
    empty: { title: 'No cancellations scheduled', description: 'Nobody has asked to cancel at the end of a period.' },
  },
  {
    id: 'comped',
    label: 'Comped',
    filters: { source: 'admin_grant', status: NOT_TERMINAL },
    empty: { title: 'No comped plans', description: 'Plans an admin grants without billing appear here.' },
  },
  {
    id: 'churned',
    label: 'Churned (30 days)',
    filters: { status: ['canceled'], cancel: 'last30' },
    empty: { title: 'No churn in the last 30 days', description: 'No subscription ended in the last 30 days.' },
  },
  {
    id: 'all',
    label: 'All',
    filters: {},
    empty: { title: 'No subscriptions yet', description: 'Paid plans appear here once someone checks out.' },
  },
];

/** The patch that opens a view: every filter cleared, then the view's own. */
export const applySubscriptionsView = (view: SubscriptionsBuiltInView): Partial<SubscriptionsListParams> => ({
  ...CLEARED_FILTER_PARAMS,
  ...view.filters,
});

const filterValues = (view: Partial<SubscriptionsListView>): SavedViewValues =>
  Object.fromEntries(
    SUBSCRIPTIONS_FILTER_KEYS.map(key => {
      const value = view[key];
      return [key, Array.isArray(value) && value.length === 0 ? undefined : value];
    })
  );

/** The built-in view the current filters are exactly, if any. Sort and page size are not compared. */
export function activeSubscriptionsView(params: SubscriptionsListView): SubscriptionsBuiltInView | undefined {
  return matchSavedView(SUBSCRIPTIONS_BUILT_IN_VIEWS, filterValues(params), view => filterValues(view.filters));
}
