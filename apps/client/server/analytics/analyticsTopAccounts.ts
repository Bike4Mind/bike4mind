import type { PipelineStage } from 'mongoose';
import { AnalyticsDaily, AnalyticsUserDay, Organization, User } from '@bike4mind/database';
import {
  resolveSubscriptionSource,
  SubscriptionOwnerType,
  SubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import type { AnalyticsOverviewQuery, AnalyticsTopAccounts, TopAccountRow } from '@client/app/utils/analyticsOverview';
import { daysBetween, resolveOverviewWindow } from './analyticsOverview';
import { shiftDay } from './analyticsRollup';

const QUERY_DEADLINE_MS = 30_000;
const OBJECT_ID = /^[a-f\d]{24}$/i;
export const TOP_ACCOUNTS_LIMIT = 10;

type Totals = { _id: string; activeDays: number; requests: number; credits: number };

// Ranked by active days, then requests (spec 4.8); the id breaks ties so the order is stable.
const RANK_STAGES: PipelineStage.FacetPipelineStage[] = [
  { $sort: { activeDays: -1, requests: -1, _id: 1 } },
  { $limit: TOP_ACCOUNTS_LIMIT },
];

/** Org plan: a Stripe subscription is paid, any other active one was granted. */
async function orgPlans(orgIds: string[]): Promise<Map<string, string>> {
  const subscriptions = await Subscription.find({
    ownerType: SubscriptionOwnerType.Organization,
    ownerId: { $in: orgIds },
    status: 'active',
  })
    .select('ownerId source subscriptionId')
    .maxTimeMS(QUERY_DEADLINE_MS)
    .lean<{ ownerId: string; source?: SubscriptionSource; subscriptionId?: string }[]>();
  const plans = new Map<string, string>();
  for (const subscription of subscriptions) {
    const paid = resolveSubscriptionSource(subscription) === SubscriptionSource.Stripe;
    if (paid || !plans.has(subscription.ownerId)) plans.set(subscription.ownerId, paid ? 'Paid' : 'Granted');
  }
  return plans;
}

const toRows = (
  totals: readonly Totals[],
  allRequests: number,
  describe: (id: string) => { name: string; plan: string | null; known: boolean }
): TopAccountRow[] =>
  totals.map(row => ({
    id: row._id,
    ...describe(row._id),
    activeDays: row.activeDays,
    requests: row.requests,
    credits: row.credits,
    share: allRequests > 0 ? (row.requests / allRequests) * 100 : 0,
  }));

/**
 * The heaviest users and orgs over the range's complete UTC days, read from analytics_user_days.
 * Suspected signups and suspended (banned) users are left out of both tables and of the org sums;
 * an org's numbers add up only the usage its members billed to it.
 */
export async function getTopAccounts(query: AnalyticsOverviewQuery, now = new Date()): Promise<AnalyticsTopAccounts> {
  const window = resolveOverviewWindow({ ...query, compare: 'off' }, now);
  if (window.completeDays === 0)
    return { covered: null, missingDays: [], users: [], orgs: [], excluded: { suspected: 0, suspended: 0 } };
  const covered = { from: window.from, to: shiftDay(window.from, window.completeDays - 1) };
  const coveredDays = { $gte: covered.from, $lte: covered.to };
  const rolledUp = (await AnalyticsDaily.distinct('day', { day: coveredDays }).maxTimeMS(
    QUERY_DEADLINE_MS
  )) as string[];
  const missingDays = daysBetween(covered.from, covered.to).filter(d => !rolledUp.includes(d));
  if (rolledUp.length === 0)
    return { covered, missingDays, users: [], orgs: [], excluded: { suspected: 0, suspended: 0 } };
  // A user-day on a day the daily rollup has not covered is left out, matching the reported missing days.
  const day = { $in: rolledUp };

  const bannedIds = (
    await User.find({ isBanned: true }).select('_id').maxTimeMS(QUERY_DEADLINE_MS).lean<{ _id: unknown }[]>()
  ).map(user => String(user._id));
  const suspended: string[] = bannedIds.length
    ? await AnalyticsUserDay.distinct('userId', { day, userId: { $in: bannedIds } }).maxTimeMS(QUERY_DEADLINE_MS)
    : [];
  const notSuspended = suspended.length ? { userId: { $nin: suspended } } : {};
  const included = { day, suspected: false, ...notSuspended };

  const [userFacet, orgTotals, suspectedCount] = await Promise.all([
    AnalyticsUserDay.aggregate<{ top: Totals[]; all: { requests: number }[] }>([
      { $match: included },
      {
        $group: {
          _id: '$userId',
          activeDays: { $sum: { $cond: [{ $ifNull: ['$active', true] }, 1, 0] } },
          requests: { $sum: '$requests' },
          credits: { $sum: '$creditsCharged' },
        },
      },
      { $facet: { top: RANK_STAGES, all: [{ $group: { _id: null, requests: { $sum: '$requests' } } }] } },
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: QUERY_DEADLINE_MS }),
    AnalyticsUserDay.aggregate<Totals>([
      {
        $match: {
          ...included,
          $or: [{ 'orgs.0': { $exists: true } }, { orgs: { $exists: false }, orgId: { $exists: true, $ne: null } }],
        },
      },
      // A row rolled up before `orgs` existed credits its whole day to `orgId`; re-running the backfill
      // with --force over those days replaces it with the per-org split.
      {
        $project: {
          day: 1,
          active: 1,
          orgs: {
            $ifNull: ['$orgs', [{ orgId: '$orgId', requests: '$requests', creditsCharged: '$creditsCharged' }]],
          },
        },
      },
      { $unwind: '$orgs' },
      {
        $group: {
          _id: { orgId: '$orgs.orgId', day: '$day' },
          active: { $max: { $cond: [{ $ifNull: ['$orgs.active', { $ifNull: ['$active', true] }] }, 1, 0] } },
          requests: { $sum: '$orgs.requests' },
          credits: { $sum: '$orgs.creditsCharged' },
        },
      },
      {
        $group: {
          _id: '$_id.orgId',
          activeDays: { $sum: '$active' },
          requests: { $sum: '$requests' },
          credits: { $sum: '$credits' },
        },
      },
      ...RANK_STAGES,
    ])
      .allowDiskUse(true)
      .option({ maxTimeMS: QUERY_DEADLINE_MS }),
    AnalyticsUserDay.aggregate<{ count: number }>([
      { $match: { day, suspected: true, ...notSuspended } },
      { $group: { _id: '$userId' } },
      { $count: 'count' },
    ]).option({ maxTimeMS: QUERY_DEADLINE_MS }),
  ]);

  const topUsers = userFacet[0]?.top ?? [];
  const allRequests = userFacet[0]?.all[0]?.requests ?? 0;
  const objectIds = (rows: readonly Totals[]) => rows.map(row => row._id).filter(id => OBJECT_ID.test(id));
  const [users, orgs, plans] = await Promise.all([
    User.find({ _id: { $in: objectIds(topUsers) } })
      .select('_id name username email level')
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean<{ _id: unknown; name?: string; username?: string; email?: string; level?: string }[]>(),
    Organization.find({ _id: { $in: objectIds(orgTotals) } })
      .select('_id name')
      .maxTimeMS(QUERY_DEADLINE_MS)
      .lean<{ _id: unknown; name?: string }[]>(),
    orgPlans(orgTotals.map(row => row._id)),
  ]);
  const userById = new Map(users.map(user => [String(user._id), user]));
  const orgById = new Map(orgs.map(org => [String(org._id), org]));

  return {
    covered,
    missingDays,
    users: toRows(topUsers, allRequests, id => {
      const user = userById.get(id);
      // A user-day can outlive its user (deleted, or a non-ObjectId id); the id is still a usable label.
      return { name: user?.name || user?.username || user?.email || id, plan: user?.level ?? null, known: !!user };
    }),
    orgs: toRows(orgTotals, allRequests, id => {
      const org = orgById.get(id);
      return { name: org?.name || id, plan: org ? (plans.get(id) ?? 'Free') : null, known: !!org };
    }),
    excluded: { suspected: suspectedCount[0]?.count ?? 0, suspended: suspended.length },
  };
}
