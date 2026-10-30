import {
  convertPipelineForDocumentDB,
  executeFacetCompatible,
  type RevenueSnapshotInput,
  type RevenueSnapshotMrr,
} from '@bike4mind/database';
import { SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import type { AdminRevenueTotals } from '@client/app/utils/adminRevenue';
import { addUtcDays, utcDayStart } from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY, type AdminSubscriptionsMrrTotal } from '@client/app/utils/adminSubscriptionsFilter';
import { Subscription } from '@server/models/Subscription';
import {
  billedGroupStages,
  mrrGroupStages,
  mrrTotal,
  mrrTotalsBy,
  type MrrGroup,
} from '../subscriptionsList/subscriptionMrr';
import { cancelCondition, viewConditions } from '../subscriptionsList/subscriptionViewConditions';

/**
 * Revenue totals per docs/admin-subscriptions-spec.md section 5.3, shared by GET /api/admin/revenue and the
 * daily snapshot cron in apps/workers so the page and the trend agree on what MRR means.
 */

type Condition = Record<string, unknown>;

// ms
const REVENUE_MAX_TIME_MS = 20_000;

const createdWithin = (from: Date, to: Date): Condition => ({ createdAt: { $gte: from, $lt: to } });

// Stripe's canceled_at is when a cancel was requested, so a scheduled cancel ends at `cancelAt`;
// canceled_at is the end only for an immediate one.
export const churnedWithin = (from: Date, to: Date): Condition => ({
  source: SubscriptionSource.Stripe,
  status: 'canceled',
  $or: [{ cancelAt: { $gte: from, $lt: to } }, { cancelAt: null, canceledAt: { $gte: from, $lt: to } }],
});

export type RevenueBreakdownEntry = { key: string | null; count: number; mrr: AdminSubscriptionsMrrTotal };

export type RevenueTotals = Omit<AdminRevenueTotals, 'arr'> & {
  byPlan: RevenueBreakdownEntry[];
  byOwnerType: RevenueBreakdownEntry[];
};

export function revenueFacets(now: Date, movement: { from: Date; to: Date }): Record<string, Condition[]> {
  const views = viewConditions(now);
  return {
    mrr: mrrGroupStages(),
    byPlan: mrrGroupStages(undefined, { priceId: '$priceId' }),
    byOwnerType: mrrGroupStages(undefined, { ownerType: '$ownerType' }),
    pastDue: mrrGroupStages(views.pastDue),
    canceling: mrrGroupStages(cancelCondition('scheduled', now)),
    newMrr: mrrGroupStages(createdWithin(movement.from, movement.to)),
    churned: billedGroupStages(churnedWithin(movement.from, movement.to)),
  };
}

type RevenueFacetResult = Record<
  'mrr' | 'pastDue' | 'canceling' | 'newMrr' | 'churned',
  MrrGroup<Record<string, unknown>>[]
> & {
  byPlan: MrrGroup<{ priceId: unknown }>[];
  byOwnerType: MrrGroup<{ ownerType: unknown }>[];
};

const breakdown = <Key extends string>(groups: MrrGroup<Record<Key, unknown>>[], key: Key): RevenueBreakdownEntry[] =>
  [...mrrTotalsBy(groups, key)]
    .map(([value, entry]) => ({ key: value, ...entry }))
    .sort((left, right) => right.mrr.amount - left.mrr.amount || right.count - left.count);

export function revenueTotalsFromFacets(result: RevenueFacetResult): RevenueTotals {
  const mrr = mrrTotal(result.mrr);
  return {
    mrr,
    // MRR_MATCH is the Paying view, so its rows are the paying count, priced or not.
    payingCount: result.mrr.reduce((sum, group) => sum + group.count, 0),
    newMrr: mrrTotal(result.newMrr),
    churnedMrr: mrrTotal(result.churned),
    pastDueMrr: mrrTotal(result.pastDue),
    cancelingMrr: mrrTotal(result.canceling),
    byPlan: breakdown(result.byPlan, 'priceId'),
    byOwnerType: breakdown(result.byOwnerType, 'ownerType'),
  };
}

export async function computeRevenueTotals(now: Date, movement: { from: Date; to: Date }): Promise<RevenueTotals> {
  const [result] = await executeFacetCompatible(
    Subscription,
    convertPipelineForDocumentDB([{ $match: { source: SubscriptionSource.Stripe } }]),
    revenueFacets(now, movement),
    { maxTimeMS: REVENUE_MAX_TIME_MS }
  );
  return revenueTotalsFromFacets(result as RevenueFacetResult);
}

const stored = ({ amount, unpriced, otherCurrency }: AdminSubscriptionsMrrTotal): RevenueSnapshotMrr => ({
  amount,
  unpriced,
  otherCurrency,
});

const storedBreakdown = <Key extends 'priceId' | 'ownerType'>(entries: RevenueBreakdownEntry[], key: Key) =>
  entries.map(
    entry =>
      ({ [key]: entry.key, count: entry.count, ...stored(entry.mrr) }) as Record<Key, string | null> & {
        count: number;
      } & RevenueSnapshotMrr
  );

export function toRevenueSnapshot(day: string, computedAt: Date, totals: RevenueTotals): RevenueSnapshotInput {
  return {
    snapshotDate: day,
    computedAt,
    currency: MRR_CURRENCY,
    mrr: stored(totals.mrr),
    payingCount: totals.payingCount,
    mrrByPlan: storedBreakdown(totals.byPlan, 'priceId'),
    mrrByOwnerType: storedBreakdown(totals.byOwnerType, 'ownerType'),
    newMrr: stored(totals.newMrr),
    churnedMrr: stored(totals.churnedMrr),
    pastDueMrr: stored(totals.pastDueMrr),
    cancelingMrr: stored(totals.cancelingMrr),
  };
}

/** Totals as of `now` (the cron runs just after `day` ends); New and Churned MRR cover `day` alone. */
export async function computeRevenueSnapshot(day: string, now: Date): Promise<RevenueSnapshotInput> {
  const totals = await computeRevenueTotals(now, { from: utcDayStart(day), to: utcDayStart(addUtcDays(day, 1)) });
  return toRevenueSnapshot(day, now, totals);
}
