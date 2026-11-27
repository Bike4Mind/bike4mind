import { z } from 'zod';

/**
 * Contract of GET /api/admin/payments, /summary and /export (Revenue > Payments). React-free because the
 * server imports it. Amounts are minor units with a lowercase currency code, on a cash basis: a payment
 * counts on the day it was charged, a refund or lost dispute on the day it happened.
 */

export const PAYMENT_KINDS = ['subscription', 'credit_purchase'] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** `succeeded` rows count toward gross; `refunded`, `partially_refunded`, `disputed` and `dispute_lost` did too when charged. */
export const PAYMENT_STATUSES = [
  'succeeded',
  'pending',
  'failed',
  'refunded',
  'partially_refunded',
  'disputed',
  'dispute_lost',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_OWNER_TYPES = ['user', 'organization'] as const;
export type PaymentOwnerType = (typeof PAYMENT_OWNER_TYPES)[number];

export const ADMIN_PAYMENTS_PAGE_SIZES = [25, 50, 100] as const;
export const ADMIN_PAYMENTS_EXPORT_MAX_ROWS = 10_000;
/** Longest range one request may cover, in days, so every read stays bounded. */
export const ADMIN_PAYMENTS_MAX_RANGE_DAYS = 731;
export const ADMIN_PAYMENTS_DEFAULT_RANGE_DAYS = 30;
/** Credit packs are sold in USD only and the ledger row stores no currency. */
export const CREDIT_PURCHASE_CURRENCY = 'usd';

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const isoDay = z
  .string()
  .regex(ISO_DAY, 'Use YYYY-MM-DD')
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Not a date');

export const toIsoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The default range: the last ADMIN_PAYMENTS_DEFAULT_RANGE_DAYS UTC days, today included. */
export function defaultPaymentsRange(now: Date): { from: string; to: string } {
  return {
    from: toIsoDay(new Date(now.getTime() - (ADMIN_PAYMENTS_DEFAULT_RANGE_DAYS - 1) * DAY_MS)),
    to: toIsoDay(now),
  };
}

const minorAmount = z.coerce.number().int().min(0).max(10_000_000_000);

const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(value => (value === '' ? undefined : value), z.enum(values).optional());

export const AdminPaymentsFilterSchema = z
  .object({
    /** UTC days, both inclusive. */
    from: isoDay.optional(),
    to: isoDay.optional(),
    kind: optionalEnum(PAYMENT_KINDS),
    status: optionalEnum(PAYMENT_STATUSES),
    ownerType: optionalEnum(PAYMENT_OWNER_TYPES),
    currency: z.preprocess(
      value => (value === '' ? undefined : typeof value === 'string' ? value.toLowerCase() : value),
      z
        .string()
        .regex(/^[a-z]{3}$/)
        .optional()
    ),
    /** Minor units, inclusive. */
    minAmount: z.preprocess(value => (value === '' ? undefined : value), minorAmount.optional()),
    maxAmount: z.preprocess(value => (value === '' ? undefined : value), minorAmount.optional()),
    /** A name, email, owner id, `pi_`/`in_` reference. Never persisted in the URL. */
    search: z.preprocess(
      value => (typeof value === 'string' ? value.trim() || undefined : value),
      z.string().max(200).optional()
    ),
  })
  .refine(({ from, to }) => !from || !to || from <= to, { message: '`from` must not be after `to`', path: ['from'] })
  .refine(({ from, to }) => !from || !to || daysBetween(from, to) <= ADMIN_PAYMENTS_MAX_RANGE_DAYS, {
    message: `Range must be at most ${ADMIN_PAYMENTS_MAX_RANGE_DAYS} days`,
    path: ['from'],
  })
  .refine(({ minAmount, maxAmount }) => minAmount === undefined || maxAmount === undefined || minAmount <= maxAmount, {
    message: '`minAmount` must not exceed `maxAmount`',
    path: ['minAmount'],
  });
export type AdminPaymentsFilter = z.infer<typeof AdminPaymentsFilterSchema>;

const pageSize = z.coerce
  .number()
  .int()
  .refine(value => (ADMIN_PAYMENTS_PAGE_SIZES as readonly number[]).includes(value), 'Page size must be 25, 50 or 100');

export const AdminPaymentsQuerySchema = AdminPaymentsFilterSchema.and(
  z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: pageSize.default(25),
  })
);
export type AdminPaymentsQuery = z.infer<typeof AdminPaymentsQuerySchema>;

/** Days covered by an inclusive range of UTC days. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** The filter's range as half-open UTC instants `[start, end)`, with the defaults applied. */
export function resolvePaymentsWindow(
  filter: Pick<AdminPaymentsFilter, 'from' | 'to'>,
  now: Date
): { from: string; to: string; start: Date; end: Date } {
  const fallback = defaultPaymentsRange(now);
  const to = filter.to ?? fallback.to;
  const from =
    filter.from ?? toIsoDay(new Date(Date.parse(`${to}T00:00:00Z`) - (ADMIN_PAYMENTS_DEFAULT_RANGE_DAYS - 1) * DAY_MS));
  return {
    from,
    to,
    start: new Date(`${from}T00:00:00Z`),
    end: new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS),
  };
}

/** The window of the same length that ends the day before `from`. */
export function previousPaymentsWindow(from: string, to: string): { from: string; to: string } {
  const days = daysBetween(from, to);
  const previousTo = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS);
  return { from: toIsoDay(new Date(previousTo.getTime() - (days - 1) * DAY_MS)), to: toIsoDay(previousTo) };
}

export type AdminPaymentOwner =
  | { kind: 'user'; id: string; name: string | null; email: string | null }
  | { kind: 'organization'; id: string; name: string | null };

export type AdminPaymentRow = {
  /** The ledger row id for a credit purchase, the BillingEvent id for a subscription payment. */
  id: string;
  kind: PaymentKind;
  status: PaymentStatus;
  /** ISO instant the payment was made (or attempted). */
  occurredAt: string;
  ownerType: PaymentOwnerType;
  ownerId: string;
  /** Null when the owner no longer exists. */
  owner: AdminPaymentOwner | null;
  amount: number;
  currency: string;
  /** Cumulative amount refunded so far; null when none is known. */
  refundedAmount: number | null;
  /** Credits granted by a credit purchase; null for subscription payments. */
  credits: number | null;
  paymentIntentId: string | null;
  invoiceId: string | null;
  /** Stripe subscription id (`sub_...`) of a subscription payment. */
  subscriptionId: string | null;
};

export type AdminPaymentsListResponse = {
  payments: AdminPaymentRow[];
  total: number;
  page: number;
  totalPages: number;
  /** The search matched more owners than one request resolves. */
  searchTruncated: boolean;
};

/**
 * `complete`: the BillingEvent store covers the whole range. `partial`: it starts inside the range, so
 * subscription payments, refunds and disputes before `recordedFrom` are missing. `unavailable`: nothing
 * recorded at or before the range end, so those totals are unknown (null), never zero.
 */
export type PaymentsCoverage = {
  recordedFrom: string | null;
  stripeEvents: 'complete' | 'partial' | 'unavailable';
};

export type PaymentsCurrencyTotals = {
  currency: string;
  /** Null when subscription payments are unavailable for the range; 0 when the Type filter leaves them out. */
  subscriptionGross: number | null;
  subscriptionCount: number | null;
  creditGross: number;
  creditCount: number;
  /** Refunds issued in the range, whatever day the payment was made. */
  refunds: number;
  disputeLosses: number;
  /** Gross minus refunds minus dispute losses; null when subscription payments are unavailable. */
  net: number | null;
};

export type PaymentsPayers = {
  /** Distinct owners with a successful payment in the range. An organization counts once. */
  total: number;
  subscriptionOnly: number;
  creditOnly: number;
  both: number;
};

export type CreditBuyerStats = {
  purchases: number;
  buyers: number;
  /** Buyers with no completed purchase before the range. */
  firstTime: number;
  /** Buyers who had a completed purchase before the range. */
  repeat: number;
};

export type PaymentsPeriodSummary = {
  from: string;
  to: string;
  totals: PaymentsCurrencyTotals[];
  payers: PaymentsPayers;
  creditBuyers: CreditBuyerStats;
  coverage: PaymentsCoverage;
};

export type PaymentsSeriesPoint = {
  /** Bucket start, `YYYY-MM-DD` (UTC). */
  date: string;
  currency: string;
  subscription: number;
  creditPurchase: number;
};

export type AdminPaymentsSummaryResponse = {
  current: PaymentsPeriodSummary;
  previous: PaymentsPeriodSummary;
  bucket: 'day' | 'month';
  series: PaymentsSeriesPoint[];
  searchTruncated: boolean;
};
