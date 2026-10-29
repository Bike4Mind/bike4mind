import { z } from 'zod';

/**
 * The admin subscriptions list's filter contract, shared by the list page and GET /api/admin/subscriptions
 * (plus its summary and export), so every surface selects the same rows. Pure and React-free: the server
 * imports it. See docs/admin-subscriptions-spec.md sections 5.1 and 6.5.
 */

/** Stripe's subscription statuses as stored on a Subscription row. */
export const SUBSCRIPTION_STATUS_FILTERS = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'canceled',
  'paused',
] as const;
export type SubscriptionStatusFilter = (typeof SUBSCRIPTION_STATUS_FILTERS)[number];

// Must stay in sync with SubscriptionOwnerType and SubscriptionSource in
// packages/server-utils/src/lib/subscriptions/types.ts, which the client bundle cannot import.
export const SUBSCRIPTION_OWNER_TYPE_FILTERS = ['User', 'Organization'] as const;
export const SUBSCRIPTION_SOURCE_FILTERS = ['stripe', 'admin_grant'] as const;
export const SUBSCRIPTION_INTERVAL_FILTERS = ['monthly', 'yearly'] as const;
/** `overdue` is a non-terminal row whose period already ended: a renewal that never landed. */
export const SUBSCRIPTION_RENEWS_FILTERS = ['next7', 'next30', 'overdue'] as const;
/**
 * `scheduled` is a non-terminal row with a cancel requested. `last30` is canceledAt within CHURNED_WINDOW_MS
 * on any status, so the Churned view pairs it with status canceled.
 */
export const SUBSCRIPTION_CANCEL_FILTERS = ['scheduled', 'last30'] as const;

/** Plan filter value for rows whose price id is not in the checkout catalog. */
export const UNKNOWN_PLAN_FILTER = 'unknown';

export const ADMIN_SUBSCRIPTIONS_SORT_FIELDS = ['createdAt', 'periodEndsAt'] as const;
export type AdminSubscriptionsSortField = (typeof ADMIN_SUBSCRIPTIONS_SORT_FIELDS)[number];

export const ADMIN_SUBSCRIPTIONS_PAGE_SIZES = [25, 50, 100] as const;

// Routes pass this as qs's arrayLimit too: past qs's default of 20, a list parses as an object.
export const ADMIN_SUBSCRIPTIONS_LIST_MAX = 50;

/** Rows one CSV export may hold; past this the file ends with a truncation line. */
export const ADMIN_SUBSCRIPTIONS_EXPORT_MAX_ROWS = 10_000;

/** ms per `renews` window. */
export const RENEWS_WINDOW_MS: Record<'next7' | 'next30', number> = {
  next7: 7 * 86_400_000,
  next30: 30 * 86_400_000,
};

/** The Churned view's look-back, ms. */
export const CHURNED_WINDOW_MS = 30 * 86_400_000;

/**
 * MRR totals are in this currency (Stripe's lowercase code); checkout bills USD only. A row billed in
 * another currency keeps its own amount on the row and is counted, not summed, in the totals.
 */
export const MRR_CURRENCY = 'usd';

/** Stripe-billed rows in these statuses count toward MRR (docs/admin-subscriptions-spec.md section 5.3). */
export const MRR_STATUSES = ['active', 'past_due'] as const satisfies readonly SubscriptionStatusFilter[];

const MRR_STATUS_SET: ReadonlySet<string> = new Set(MRR_STATUSES);

/** Whether a row counts toward MRR. The summary's MRR aggregation selects the same rows. */
export const countsTowardMrr = (row: { source?: string | null; status: string }): boolean =>
  row.source === 'stripe' && MRR_STATUS_SET.has(row.status);

// A query string carries a one-item list as a bare string.
const listOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    value => (typeof value === 'string' ? [value] : value),
    z.array(z.enum(values)).max(ADMIN_SUBSCRIPTIONS_LIST_MAX)
  );

const stringList = z.preprocess(
  value => (typeof value === 'string' ? [value] : value),
  z.array(z.string().trim().min(1).max(200)).max(ADMIN_SUBSCRIPTIONS_LIST_MAX)
);

export const AdminSubscriptionsFilterSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: listOf(SUBSCRIPTION_STATUS_FILTERS).optional(),
  /** Price ids, or `unknown` for prices the catalog does not list. */
  plan: stringList.optional(),
  ownerType: z.enum(SUBSCRIPTION_OWNER_TYPE_FILTERS).optional(),
  source: z.enum(SUBSCRIPTION_SOURCE_FILTERS).optional(),
  interval: z.enum(SUBSCRIPTION_INTERVAL_FILTERS).optional(),
  renews: z.enum(SUBSCRIPTION_RENEWS_FILTERS).optional(),
  cancel: z.enum(SUBSCRIPTION_CANCEL_FILTERS).optional(),
});
export type AdminSubscriptionsFilter = z.infer<typeof AdminSubscriptionsFilterSchema>;

const pageSize = z.coerce
  .number()
  .int()
  .refine(
    value => (ADMIN_SUBSCRIPTIONS_PAGE_SIZES as readonly number[]).includes(value),
    'Page size must be 25, 50 or 100'
  );

/** GET /api/admin/subscriptions. */
export const AdminSubscriptionsQuerySchema = AdminSubscriptionsFilterSchema.extend({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: pageSize.default(25),
  sortField: z.enum(ADMIN_SUBSCRIPTIONS_SORT_FIELDS).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});
export type AdminSubscriptionsListParams = z.infer<typeof AdminSubscriptionsQuerySchema>;

export type AdminSubscriptionPlan = {
  priceId: string | null;
  /** `null` when the price id is not in the checkout catalog. */
  name: string | null;
  interval: (typeof SUBSCRIPTION_INTERVAL_FILTERS)[number] | null;
};

export type AdminSubscriptionOwner =
  | {
      kind: 'User';
      id: string;
      name: string | null;
      username: string | null;
      email: string | null;
      stripeCustomerId: string | null;
    }
  | {
      kind: 'Organization';
      id: string;
      name: string | null;
      stripeCustomerId: string | null;
      seats: number | null;
      /** Members plus the owner, the same count seat validation uses. */
      memberCount: number | null;
      billingOwnerId: string | null;
    };

/** Stripe's recurring price intervals, as mirrored on a Subscription row. */
export const BILLED_INTERVALS = ['day', 'week', 'month', 'year'] as const;
export type BilledInterval = (typeof BILLED_INTERVALS)[number];

/** How often Stripe bills the row: every `intervalCount` (at least 1) `interval`s. */
export type AdminSubscriptionBilledInterval = { interval: BilledInterval; intervalCount: number };

/** A row's contribution to MRR: the billed amount per month, in minor units of `currency`, rounded. */
export type AdminSubscriptionMrr = { amount: number; currency: string };

export type AdminSubscriptionRow = {
  id: string;
  subscriptionId: string;
  ownerType: (typeof SUBSCRIPTION_OWNER_TYPE_FILTERS)[number];
  ownerId: string;
  /** `null` when the owner record is gone. */
  owner: AdminSubscriptionOwner | null;
  plan: AdminSubscriptionPlan;
  /** Mirrored from Stripe; `null` on comps and on rows not synced yet, which fall back to `plan.interval`. */
  billedInterval: AdminSubscriptionBilledInterval | null;
  status: string;
  source: (typeof SUBSCRIPTION_SOURCE_FILTERS)[number];
  quantity: number;
  customCreditsPerCycle: number | null;
  /**
   * `null` for a row that does not count toward MRR (comps, statuses outside MRR_STATUSES) and for one
   * with no billed amount mirrored from Stripe yet.
   */
  mrr: AdminSubscriptionMrr | null;
  periodStartsAt: string;
  periodEndsAt: string;
  canceledAt: string | null;
  createdAt: string;
};

export type AdminSubscriptionsListResponse = {
  subscriptions: AdminSubscriptionRow[];
  total: number;
  page: number;
  totalPages: number;
  /** True when a free-text search matched more owners than it could resolve; narrow the search. */
  searchTruncated: boolean;
};

export type AdminSubscriptionsMrrTotal = {
  currency: typeof MRR_CURRENCY;
  /** Per month, in minor units, rounded once after summing. */
  amount: number;
  /** Rows that count but have no billed amount mirrored yet, left out of `amount`. */
  unpriced: number;
  /** Rows billed in another currency, left out of `amount`. */
  otherCurrency: number;
};

/**
 * Counts for the built-in views and the MRR totals, each intersected with the current filters. Canceling is
 * counted by the summary route with cancel=scheduled, not a views field. Mismatched arrives with reconciliation.
 */
export type AdminSubscriptionsSummary = {
  total: number;
  views: { paying: number; pastDue: number; comped: number; churned: number };
  /** MRR of the matching rows, by the same definition as the row `mrr`. */
  mrr: AdminSubscriptionsMrrTotal;
  /** The part of `mrr` from rows the Past due view counts: MRR at risk. */
  pastDueMrr: AdminSubscriptionsMrrTotal;
  /** Same meaning as on the list response: the counts cover only the owners the search resolved. */
  searchTruncated: boolean;
};
