import { z } from 'zod';

/**
 * GET /api/admin/billing-overview: one owner's read-only billing summary, shown on the user profile's
 * Billing tab and in the organization profile. Shared by the route (pages/api/admin/billing-overview.ts)
 * and the client. Every section loads on its own, so one failed source leaves the rest readable.
 * Money is in minor units of a lowercase Stripe currency code, and amounts in different currencies are
 * never added together.
 */

export const BILLING_OWNER_TYPES = ['user', 'organization'] as const;
export type BillingOwnerType = (typeof BILLING_OWNER_TYPES)[number];

export const BILLING_RANGES = ['30d', '90d', '365d'] as const;
export type BillingRange = (typeof BILLING_RANGES)[number];
export const DEFAULT_BILLING_RANGE: BillingRange = '90d';
export const BILLING_RANGE_DAYS: Readonly<Record<BillingRange, number>> = { '30d': 30, '90d': 90, '365d': 365 };
export const BILLING_RANGE_LABELS: Readonly<Record<BillingRange, string>> = {
  '30d': '30 days',
  '90d': '90 days',
  '365d': '12 months',
};

export const isBillingRange = (value: unknown): value is BillingRange =>
  typeof value === 'string' && (BILLING_RANGES as readonly string[]).includes(value);

export const BillingOverviewQuerySchema = z.object({
  ownerType: z.enum(BILLING_OWNER_TYPES),
  ownerId: z.string().regex(/^[a-f0-9]{24}$/i, 'Owner id must be an ObjectId'),
  range: z.enum(BILLING_RANGES).default(DEFAULT_BILLING_RANGE),
});
export type BillingOverviewQuery = z.infer<typeof BillingOverviewQuerySchema>;

const unavailable = z.object({ status: z.literal('unavailable'), message: z.string() });

/** A section that loaded, or the reason it did not. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  z.discriminatedUnion('status', [z.object({ status: z.literal('ok'), ...shape }), unavailable]);

export const SUBSCRIPTION_STANDINGS = ['paid', 'past_due', 'trial', 'comped', 'ended', 'none'] as const;
export type SubscriptionStanding = (typeof SUBSCRIPTION_STANDINGS)[number];

const billingSubscription = z.object({
  id: z.string(),
  planName: z.string().nullable(),
  status: z.string(),
  source: z.enum(['stripe', 'admin_grant']),
  comped: z.boolean(),
  quantity: z.number(),
  periodEndsAt: z.string().nullable(),
  /** When a scheduled cancel takes effect; null when the row renews. */
  cancelAt: z.string().nullable(),
  canceledAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type BillingSubscription = z.infer<typeof billingSubscription>;

const fundingCredits = z.object({
  purchased: z.number(),
  subscription: z.number(),
  granted: z.number(),
  /** Balance the credit lots do not account for (pre-lot history, absolute-set adjustments). */
  unknown: z.number(),
});
export type BillingFundingCredits = z.infer<typeof fundingCredits>;

export const PAYMENT_KINDS = ['credit_purchase', 'subscription_payment', 'refund', 'dispute'] as const;
export type BillingPaymentKind = (typeof PAYMENT_KINDS)[number];

const moneyTotal = z.object({ count: z.number(), amount: z.number() });

const currencyTotals = z.object({
  /** Lowercase Stripe code, or null when the source did not record one (never assumed to be USD). */
  currency: z.string().nullable(),
  creditPurchases: moneyTotal,
  subscriptionPayments: moneyTotal,
  refunds: moneyTotal,
  disputes: moneyTotal,
});
export type BillingCurrencyTotals = z.infer<typeof currencyTotals>;

/** Where a record's authoritative detail lives in the admin. */
const billingLink = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('subscription'), subscriptionId: z.string(), tab: z.enum(['overview', 'invoices']) }),
  z.object({ kind: z.literal('userCredits'), userId: z.string() }),
  /** The Activity tab narrowed to spend over the same days (inclusive UTC `YYYY-MM-DD`). */
  z.object({ kind: z.literal('userActivity'), userId: z.string(), from: z.string(), to: z.string() }),
  z.object({ kind: z.literal('organization'), organizationId: z.string() }),
  z.object({ kind: z.literal('disputes') }),
]);
export type BillingLink = z.infer<typeof billingLink>;

const paymentRecord = z.object({
  id: z.string(),
  kind: z.enum(PAYMENT_KINDS),
  at: z.string(),
  /** Null when the source sent no amount: shown as "No amount", never as zero. */
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  /** e.g. "Pack of 10,000 credits", "Renewed", "Partially refunded". */
  label: z.string(),
  /** Status as the source states it: completed, refunded, lost, under_review... */
  status: z.string().nullable(),
  /** Credits granted, for a credit purchase. */
  credits: z.number().nullable(),
  paymentIntentId: z.string().nullable(),
  link: billingLink.nullable(),
});
export type BillingPaymentRecord = z.infer<typeof paymentRecord>;

const usageAttribution = z.object({
  /** Who the usage was billed to. */
  billedTo: z.enum(['user', 'organization', 'agent']),
  billedToId: z.string(),
  billedToName: z.string().nullable(),
  /** For an organization's own view: the member who ran it. */
  actorUserId: z.string().nullable(),
  actorName: z.string().nullable(),
  credits: z.number(),
  events: z.number(),
  lastAt: z.string().nullable(),
  link: billingLink.nullable(),
});
export type BillingUsageAttribution = z.infer<typeof usageAttribution>;

export const ACTIVITY_KINDS = ['payment', 'refund', 'dispute', 'credit_issued', 'consumption'] as const;
export type BillingActivityKind = (typeof ACTIVITY_KINDS)[number];

const activityItem = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  summary: z.string(),
  /** Signed: positive for credits issued, negative for consumption. */
  credits: z.number().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  /**
   * Set only when the source records the link (the same Stripe payment intent on both rows). Anything
   * that merely happened nearby in time stays unlinked.
   */
  verifiedLinkTo: z.string().nullable(),
  link: billingLink.nullable(),
});
export type BillingActivityItem = z.infer<typeof activityItem>;

export const BillingOverviewSchema = z.object({
  owner: z.object({
    type: z.enum(BILLING_OWNER_TYPES),
    id: z.string(),
    name: z.string().nullable(),
    internal: z.boolean(),
  }),
  window: z.object({ range: z.enum(BILLING_RANGES), from: z.string(), to: z.string() }),
  generatedAt: z.string(),
  subscription: section({
    standing: z.enum(SUBSCRIPTION_STANDINGS),
    current: billingSubscription.nullable(),
    /** Up to the latest five other rows, newest first. */
    previous: z.array(billingSubscription),
  }),
  credits: section({
    available: z.number(),
    /** Reserved by requests still in flight; already taken out of `available`. */
    held: z.number(),
    heldRequests: z.number(),
    funding: fundingCredits,
  }),
  payments: section({
    totals: z.array(currencyTotals),
    records: z.array(paymentRecord),
    truncated: z.boolean(),
    /** Stripe events are stored from this date on; before it only credit purchases are known. */
    eventsRecordedSince: z.string().nullable(),
    /** True when the coverage date could not be read, so a null date does not mean no events exist. */
    eventsCoverageUnknown: z.boolean().optional(),
  }),
  usage: section({
    lastSuccessfulAt: z.string().nullable(),
    attribution: z.array(usageAttribution),
    truncated: z.boolean(),
    /** Usage events are stored from this date on. */
    recordedSince: z.string().nullable(),
    link: billingLink.nullable(),
  }),
  activity: section({ items: z.array(activityItem), truncated: z.boolean() }),
});
export type BillingOverview = z.infer<typeof BillingOverviewSchema>;
export type BillingOverviewSection<K extends 'subscription' | 'credits' | 'payments' | 'usage' | 'activity'> =
  BillingOverview[K];
