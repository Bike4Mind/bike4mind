import { z } from 'zod';
import type {
  AdminSubscriptionPlan,
  AdminSubscriptionRow,
  AdminSubscriptionsMrrTotal,
} from './adminSubscriptionsFilter';

/** Contract of GET /api/admin/revenue; React-free because the server imports it.
 * See docs/admin-subscriptions-spec.md sections 5.3 and 6.4. */

export const REVENUE_RANGES = ['30d', '90d', '12m'] as const;
export type RevenueRange = (typeof REVENUE_RANGES)[number];

/** Today included. */
export const REVENUE_RANGE_DAYS: Readonly<Record<RevenueRange, number>> = { '30d': 30, '90d': 90, '12m': 365 };

export const REVENUE_AT_RISK_LIMIT = 10;

export const AdminRevenueQuerySchema = z.object({ range: z.enum(REVENUE_RANGES).default('30d') });

/** `mrr` is in minor units of MRR_CURRENCY. */
export type RevenueTrendPoint = { date: string; mrr: number; payingCount: number };

export type RevenuePlanRow = {
  plan: AdminSubscriptionPlan;
  subscriptions: number;
  mrr: AdminSubscriptionsMrrTotal;
  /** 0 to 1; null while the total MRR is 0. */
  share: number | null;
};

export type AdminRevenueTotals = {
  mrr: AdminSubscriptionsMrrTotal;
  /** MRR x 12, minor units. */
  arr: number;
  payingCount: number;
  /** MRR of subscriptions created in the range that count toward MRR now. */
  newMrr: AdminSubscriptionsMrrTotal;
  /** MRR of Stripe subscriptions that ended in the range (`cancelAt`, else `canceledAt`), at the price they were billed; excludes rows created in the same range. */
  churnedMrr: AdminSubscriptionsMrrTotal;
  pastDueMrr: AdminSubscriptionsMrrTotal;
  cancelingMrr: AdminSubscriptionsMrrTotal;
};

export type AdminRevenueData = {
  stripeConfigured: true;
  range: RevenueRange;
  /** `from` and `to` are UTC days, `YYYY-MM-DD`. */
  from: string;
  to: string;
  current: AdminRevenueTotals;
  /** The first snapshot in the range, which the MRR tile compares against; null when the range has none. */
  startOfRange: RevenueTrendPoint | null;
  trend: RevenueTrendPoint[];
  /** The first snapshot's day, or today while none exists yet. */
  trendStartsOn: string;
  byPlan: RevenuePlanRow[];
  atRisk: {
    /** Past due or canceling rows that count toward MRR, largest MRR first, at most REVENUE_AT_RISK_LIMIT. */
    rows: AdminSubscriptionRow[];
    total: number;
    mrr: AdminSubscriptionsMrrTotal;
  };
};

export type AdminRevenueResponse = { stripeConfigured: false } | AdminRevenueData;

const DAY_MS = 86_400_000;

export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

export const utcDayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export const addUtcDays = (day: string, days: number): string =>
  utcDay(new Date(utcDayStart(day).getTime() + days * DAY_MS));

export const revenueRangeStart = (range: RevenueRange, now: Date): string =>
  addUtcDays(utcDay(now), 1 - REVENUE_RANGE_DAYS[range]);
