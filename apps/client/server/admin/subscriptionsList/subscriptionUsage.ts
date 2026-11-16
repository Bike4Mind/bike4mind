import { ACTIVE_SOURCES, NotFoundError } from '@bike4mind/common';
import { AnalyticsDaily, Organization, UsageEvent, mongoose } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { isCountedUser, loadCountingContext, loadUserFlags } from '@bike4mind/server-utils/analytics/signupCohort';
import {
  countsTowardMrr,
  type AdminSubscriptionsFilter,
} from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import { SUBSCRIPTION_USAGE_DAYS, type SubscriptionUsage } from '@bike4mind/server-utils/app/utils/subscriptionUsage';
import type { SubscriptionDoc } from './listAdminSubscriptions';

const DAY = 86_400_000;
const DEADLINE = 8_000;
const CANDIDATE_LIMIT = 2_000;
type UsageGroup = {
  _id: { ownerType: string; ownerId: string };
  firstParty: number;
  api: number;
  unclassified: number;
  credits: number;
  successful: number;
  events: number;
  lastAt: Date | null;
};

export const usageOwnerKey = (owner: { ownerType: string; ownerId: string }) => `${owner.ownerType}:${owner.ownerId}`;

export function matchesUsageCohort(
  doc: Pick<SubscriptionDoc, 'status' | 'source' | 'canceledAt' | 'cancelAt' | 'cancelAtPeriodEnd'>,
  usage: SubscriptionUsage,
  cohort: NonNullable<AdminSubscriptionsFilter['usageCohort']>
) {
  if (!countsTowardMrr(doc) || usage.coverage !== 'observed') return false;
  if (cohort === 'payingNoRecorded') return usage.recordedEvents === 0;
  return !!(doc.canceledAt || doc.cancelAt || doc.cancelAtPeriodEnd) && usage.successfulRequests > 0;
}

/** Owner-scoped raw observations, not member activity or a claim that recording was uninterrupted. */
export async function loadSubscriptionUsage(docs: SubscriptionDoc[], now = new Date()) {
  const from = new Date(now.getTime() - SUBSCRIPTION_USAGE_DAYS * DAY);
  const result = new Map<string, SubscriptionUsage>();
  if (!docs.length) return result;
  const owners = [
    ...new Map(docs.map(doc => [usageOwnerKey(doc), { ownerType: doc.ownerType, ownerId: doc.ownerId }])).values(),
  ];
  const [first, latest, groups, organizations, ctx, markers] = await Promise.all([
    UsageEvent.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).maxTimeMS(DEADLINE).lean<{ createdAt: Date }>(),
    UsageEvent.findOne({ createdAt: { $lt: now } }, { createdAt: 1 })
      .sort({ createdAt: -1 })
      .maxTimeMS(DEADLINE)
      .lean<{ createdAt: Date }>(),
    UsageEvent.aggregate<UsageGroup>([
      { $match: { $or: owners, createdAt: { $gte: from, $lt: now } } },
      // An exact replay is not another provider call. Different settlement times remain separate calls.
      {
        $group: {
          _id: {
            ownerType: '$ownerType',
            ownerId: '$ownerId',
            requestId: '$requestId',
            createdAt: '$createdAt',
            feature: '$feature',
            provider: '$provider',
            model: '$model',
            source: '$source',
            status: '$status',
          },
          credits: { $max: '$creditsCharged' },
        },
      },
      {
        $group: {
          _id: { ownerType: '$_id.ownerType', ownerId: '$_id.ownerId' },
          firstParty: {
            $sum: {
              $cond: [{ $and: [{ $eq: ['$_id.status', 'ok'] }, { $in: ['$_id.source', [...ACTIVE_SOURCES]] }] }, 1, 0],
            },
          },
          api: { $sum: { $cond: [{ $and: [{ $eq: ['$_id.status', 'ok'] }, { $eq: ['$_id.source', 'api'] }] }, 1, 0] } },
          unclassified: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$_id.status', 'ok'] }, { $eq: [{ $ifNull: ['$_id.source', null] }, null] }] },
                1,
                0,
              ],
            },
          },
          successful: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$_id.status', 'ok'] }, { $in: ['$_id.source', [...ACTIVE_SOURCES, 'api']] }] },
                1,
                0,
              ],
            },
          },
          credits: { $sum: { $max: [0, '$credits'] } },
          events: { $sum: 1 },
          lastAt: { $max: { $cond: [{ $eq: ['$_id.status', 'ok'] }, '$_id.createdAt', null] } },
        },
      },
    ]).option({ maxTimeMS: DEADLINE }),
    Organization.find(
      { _id: { $in: docs.filter(doc => doc.ownerType === 'Organization').map(doc => doc.ownerId) } },
      { userId: 1 }
    )
      .maxTimeMS(DEADLINE)
      .lean<{ _id: unknown; userId?: string }[]>(),
    loadCountingContext(),
    AnalyticsDaily.find(
      { day: { $gte: from.toISOString().slice(0, 10), $lt: now.toISOString().slice(0, 10) } },
      { day: 1, computedAt: 1 }
    )
      .limit(SUBSCRIPTION_USAGE_DAYS)
      .maxTimeMS(DEADLINE)
      .lean<{ day: string; computedAt?: Date }[]>(),
  ]);
  // Daily rows are the rollup writer's completion markers, including days with zero usage.
  const completeDays = new Set(
    markers
      .filter(marker => marker.computedAt && marker.computedAt >= new Date(`${marker.day}T00:00:00Z`))
      .map(marker => marker.day)
  );
  const historyComplete = Array.from({ length: SUBSCRIPTION_USAGE_DAYS }, (_, index) =>
    new Date(from.getTime() + index * DAY).toISOString().slice(0, 10)
  ).every(day => completeDays.has(day));
  const orgOwners = new Map(organizations.map(org => [String(org._id), org.userId]));
  const flags = await loadUserFlags(
    docs.flatMap(doc => {
      const id = doc.ownerType === 'User' ? doc.ownerId : orgOwners.get(doc.ownerId);
      return id ? [id] : [];
    }),
    DEADLINE
  );
  const byOwner = new Map(groups.map(group => [usageOwnerKey(group._id), group]));
  for (const doc of docs) {
    const ownerId = doc.ownerType === 'User' ? doc.ownerId : orgOwners.get(doc.ownerId);
    const owner = ownerId ? flags.get(ownerId) : undefined;
    const group = byOwner.get(usageOwnerKey(doc));
    const coverage: SubscriptionUsage['coverage'] = !owner
      ? 'unknown'
      : !isCountedUser(owner, ctx)
        ? 'internal'
        : !doc.createdAt
          ? 'unknown'
          : doc.createdAt > from
            ? 'new'
            : !first || !latest
              ? 'unknown'
              : !historyComplete || first.createdAt > from || latest.createdAt.getTime() < now.getTime() - DAY
                ? 'incomplete'
                : 'observed';
    const known = coverage === 'observed';
    result.set(String(doc._id), {
      from: from.toISOString(),
      to: now.toISOString(),
      queriedAt: new Date().toISOString(),
      recordedSince: first?.createdAt.toISOString() ?? null,
      latestRecordedAt: latest?.createdAt.toISOString() ?? null,
      coverage,
      firstPartyRequests: group?.unclassified ? null : (group?.firstParty ?? (known ? 0 : null)),
      apiRequests: group?.unclassified ? null : (group?.api ?? (known ? 0 : null)),
      creditsConsumed: group?.credits ?? (known ? 0 : null),
      lastSuccessfulAt: group?.lastAt?.toISOString() ?? null,
      successfulRequests: group?.successful ?? 0,
      recordedEvents: group?.events ?? 0,
    });
  }
  return result;
}

export async function subscriptionUsageCondition(
  cohort: NonNullable<AdminSubscriptionsFilter['usageCohort']>,
  now: Date
) {
  const docs = await Subscription.find({ source: 'stripe', status: { $in: ['active', 'past_due'] } })
    .limit(CANDIDATE_LIMIT + 1)
    .maxTimeMS(DEADLINE)
    .lean<SubscriptionDoc[]>();
  if (docs.length > CANDIDATE_LIMIT)
    throw new Error('Usage cohort exceeds its candidate limit; usage cohort is unavailable.');
  const usage = await loadSubscriptionUsage(docs, now);
  return {
    _id: {
      $in: docs
        .filter(doc => {
          const observation = usage.get(String(doc._id));
          return observation && matchesUsageCohort(doc, observation, cohort);
        })
        .map(doc => doc._id),
    },
  };
}

export async function subscriptionUsageDetail(id: string) {
  const doc = await Subscription.findById(new mongoose.Types.ObjectId(id)).maxTimeMS(DEADLINE).lean<SubscriptionDoc>();
  if (!doc) throw new NotFoundError('Subscription not found');
  return (await loadSubscriptionUsage([doc])).get(String(doc._id))!;
}
