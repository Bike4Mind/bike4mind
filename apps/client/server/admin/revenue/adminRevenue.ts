import {
  convertPipelineForDocumentDB,
  mongoose,
  revenueSnapshotRepository,
  type IRevenueSnapshotDocument,
} from '@bike4mind/database';
import {
  NO_PRICE_PLAN_KEY,
  REVENUE_AT_RISK_LIMIT,
  REVENUE_SPARKLINE_DAYS,
  addUtcDays,
  revenueRangeStart,
  utcDay,
  utcDayStart,
  type AdminRevenueData,
  type RevenueRange,
  type RevenueTrendPlan,
  type RevenueTrendPoint,
} from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@client/app/utils/adminSubscriptionsFilter';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { planOf, subscriptionPlanCatalog, type PlanCatalog } from '../subscriptionsList/adminSubscriptionsQuery';
import { toAdminSubscriptionRows, type SubscriptionDoc } from '../subscriptionsList/listAdminSubscriptions';
import {
  MRR_MATCH,
  mrrGroupStages,
  mrrTotal,
  subscriptionMrr,
  type MrrGroup,
} from '../subscriptionsList/subscriptionMrr';
import { cancelCondition, viewConditions } from '../subscriptionsList/subscriptionViewConditions';
import { computeRevenueTotals } from './revenueSnapshot';

// ms
const READ_MAX_TIME_MS = 20_000;
// Past this many rows the at-risk table can miss a larger one.
const AT_RISK_SCAN_LIMIT = 1_000;

// Rows in another currency or with no amount cannot be compared with USD amounts, so they rank last.
const usdMrrOf = (doc: SubscriptionDoc) => {
  const mrr = subscriptionMrr(doc);
  return mrr && mrr.currency === MRR_CURRENCY ? mrr.amount : -1;
};

async function atRiskSubscriptions(now: Date, catalog: PlanCatalog): Promise<AdminRevenueData['atRisk']> {
  const atRisk = { $or: [viewConditions(now).pastDue, cancelCondition('scheduled', now)] };
  const [docs, groups] = await Promise.all([
    Subscription.find({ $and: [MRR_MATCH, atRisk] })
      .limit(AT_RISK_SCAN_LIMIT)
      .maxTimeMS(READ_MAX_TIME_MS)
      .lean<SubscriptionDoc[]>(),
    Subscription.aggregate<MrrGroup>(
      convertPipelineForDocumentDB(mrrGroupStages(atRisk) as unknown as mongoose.PipelineStage[])
    ).option({ maxTimeMS: READ_MAX_TIME_MS }),
  ]);
  const largest = [...docs].sort((left, right) => usdMrrOf(right) - usdMrrOf(left)).slice(0, REVENUE_AT_RISK_LIMIT);
  return {
    rows: await toAdminSubscriptionRows(largest, catalog),
    total: groups.reduce((sum, group) => sum + group.count, 0),
    mrr: mrrTotal(groups),
  };
}

const planKey = (priceId: string | null) => priceId || NO_PRICE_PLAN_KEY;

const payingOf = (snapshot: IRevenueSnapshotDocument, ownerType: string) =>
  snapshot.mrrByOwnerType.find(entry => entry.ownerType === ownerType)?.count ?? 0;

export function toTrendPoint(snapshot: IRevenueSnapshotDocument): RevenueTrendPoint {
  const mrrByPlan: Record<string, number> = {};
  for (const entry of snapshot.mrrByPlan) {
    const key = planKey(entry.priceId);
    mrrByPlan[key] = (mrrByPlan[key] ?? 0) + entry.amount;
  }
  return {
    date: snapshot.snapshotDate,
    mrr: snapshot.mrr.amount,
    payingCount: snapshot.payingCount,
    newMrr: snapshot.newMrr.amount,
    churnedMrr: snapshot.churnedMrr.amount,
    pastDueMrr: snapshot.pastDueMrr.amount,
    cancelingMrr: snapshot.cancelingMrr.amount,
    payingUsers: payingOf(snapshot, 'User'),
    payingOrgs: payingOf(snapshot, 'Organization'),
    mrrByPlan,
  };
}

/** Every plan in the trend, ordered by its MRR on the last day, then by its peak, so the chart's stack is stable. */
export function trendPlans(trend: readonly RevenueTrendPoint[], catalog: PlanCatalog): RevenueTrendPlan[] {
  const last = trend.at(-1)?.mrrByPlan ?? {};
  const peak = new Map<string, number>();
  for (const point of trend) {
    for (const [key, amount] of Object.entries(point.mrrByPlan)) peak.set(key, Math.max(peak.get(key) ?? 0, amount));
  }
  return [...peak.keys()]
    .sort((left, right) => (last[right] ?? 0) - (last[left] ?? 0) || (peak.get(right) ?? 0) - (peak.get(left) ?? 0))
    .map(key => ({ key, plan: planOf(key === NO_PRICE_PLAN_KEY ? null : key, catalog) }));
}

export async function adminRevenueTrend(now = new Date()): Promise<RevenueTrendPoint[]> {
  const to = utcDay(now);
  const snapshots = await revenueSnapshotRepository.findRange(addUtcDays(to, 1 - REVENUE_SPARKLINE_DAYS), to);
  return snapshots.map(toTrendPoint);
}

// Current totals are read live so they hold before the first snapshot; only the trend reads RevenueSnapshot rows.
export async function adminRevenue(range: RevenueRange, now = new Date()): Promise<AdminRevenueData> {
  const catalog = subscriptionPlanCatalog();
  const to = utcDay(now);
  const from = revenueRangeStart(range, now);
  const [totals, snapshots, firstSnapshotDate, atRisk] = await Promise.all([
    computeRevenueTotals(now, { from: utcDayStart(from), to: now }),
    revenueSnapshotRepository.findRange(from, to),
    revenueSnapshotRepository.firstSnapshotDate(),
    atRiskSubscriptions(now, catalog),
  ]);
  const trend = snapshots.map(toTrendPoint);
  const { mrr, payingCount, newMrr, churnedMrr, pastDueMrr, cancelingMrr } = totals;
  return {
    stripeConfigured: true,
    range,
    from,
    to,
    current: { mrr, arr: mrr.amount * 12, payingCount, newMrr, churnedMrr, pastDueMrr, cancelingMrr },
    startOfRange: trend[0] ?? null,
    trend,
    trendPlans: trendPlans(trend, catalog),
    trendStartsOn: firstSnapshotDate ?? to,
    byPlan: totals.byPlan.map(entry => ({
      plan: planOf(entry.key, catalog),
      subscriptions: entry.count,
      mrr: entry.mrr,
      share: mrr.amount > 0 ? entry.mrr.amount / mrr.amount : null,
    })),
    atRisk,
  };
}
