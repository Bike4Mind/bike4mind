import { convertPipelineForDocumentDB, mongoose, revenueSnapshotRepository } from '@bike4mind/database';
import {
  REVENUE_AT_RISK_LIMIT,
  revenueRangeStart,
  utcDay,
  utcDayStart,
  type AdminRevenueData,
  type RevenueRange,
} from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@client/app/utils/adminSubscriptionsFilter';
import { Subscription } from '@server/models/Subscription';
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
  const trend = snapshots.map(snapshot => ({
    date: snapshot.snapshotDate,
    mrr: snapshot.mrr.amount,
    payingCount: snapshot.payingCount,
  }));
  const { mrr, payingCount, newMrr, churnedMrr, pastDueMrr, cancelingMrr } = totals;
  return {
    stripeConfigured: true,
    range,
    from,
    to,
    current: { mrr, arr: mrr.amount * 12, payingCount, newMrr, churnedMrr, pastDueMrr, cancelingMrr },
    startOfRange: trend[0] ?? null,
    trend,
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
