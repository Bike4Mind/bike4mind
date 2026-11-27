import type { PipelineStage } from 'mongoose';
import {
  attributedUsageMatch,
  effectiveUsageDate,
  platformUsageExpression,
  usageTimeMatch,
} from './platformUsageReporting';
import {
  FEATURE_SPIKE_TRAILING_DAYS,
  SPEND_EXCLUDED_STATUSES,
  SPEND_FAILED_STATUSES,
  type SpendFeaturesParams,
  type SpendFeatureUsersParams,
} from '@bike4mind/common';

/**
 * Aggregation pipelines behind the Spend explorer's feature view
 * (UsageEventRepository.spendFeatures / spendFeatureUsers / spendActorIds).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The spike window: the last complete UTC day before `spikeEnd` and the trailing days before it. */
export function spikeWindow(spikeEnd: Date): { lastDayStart: Date; trailingFrom: Date } {
  const lastDayStart = new Date(spikeEnd.getTime() - DAY_MS);
  return { lastDayStart, trailingFrom: new Date(lastDayStart.getTime() - FEATURE_SPIKE_TRAILING_DAYS * DAY_MS) };
}

/** Earliest event any feature pipeline reads: the range, widened to cover the trailing window. */
export function scanStart(from: Date, spikeEnd: Date): Date {
  const { trailingFrom } = spikeWindow(spikeEnd);
  return trailingFrom < from ? trailingFrom : from;
}

export type SpendScanParams = Pick<SpendFeaturesParams, 'from' | 'to' | 'spikeEnd' | 'actorUserId' | 'userFilter'> & {
  feature?: string;
};

function scanMatch(params: SpendScanParams): PipelineStage.Match {
  // Half-open [start, to), like the rest of the explorer, so adjacent windows never double count.
  const clauses: Record<string, unknown>[] = [usageTimeMatch(scanStart(params.from, params.spikeEnd), params.to)];
  if (params.feature) clauses.push({ feature: params.feature });
  if (params.actorUserId) clauses.push({ userId: params.actorUserId });
  if (params.userFilter) {
    const operator = params.userFilter.mode === 'include' ? '$in' : '$nin';
    clauses.push({ ...attributedUsageMatch, userId: { [operator]: params.userFilter.userIds } });
  }
  return { $match: clauses.length === 1 ? clauses[0] : { $and: clauses } };
}

const counted = { $or: [platformUsageExpression, { $not: [{ $in: ['$status', [...SPEND_EXCLUDED_STATUSES]] }] }] };
const failed = { $in: ['$status', [...SPEND_FAILED_STATUSES]] };

/** Per-group sums shared by both pipelines; SpendFeatureTotals says what each one means. */
function totalsAccumulators(params: { from: Date; spikeEnd: Date }) {
  const { lastDayStart, trailingFrom } = spikeWindow(params.spikeEnd);
  const inRange = { $gte: [effectiveUsageDate, params.from] };
  const countedInRange = { $and: [inRange, counted] };
  const between = (start: Date, end: Date) => [
    { $gte: [effectiveUsageDate, start] },
    { $lt: [effectiveUsageDate, end] },
  ];
  const sumIf = (condition: unknown, value: unknown) => ({ $sum: { $cond: [condition, value, 0] } });
  return {
    requests: sumIf(inRange, 1),
    failedRequests: sumIf({ $and: [inRange, failed] }, 1),
    costUsd: sumIf(countedInRange, '$costUsd'),
    creditsCharged: sumIf(countedInRange, '$creditsCharged'),
    units: sumIf(countedInRange, { $ifNull: ['$units', 0] }),
    lastDayUsd: sumIf({ $and: [...between(lastDayStart, params.spikeEnd), counted] }, '$costUsd'),
    trailingUsd: sumIf({ $and: [...between(trailingFrom, lastDayStart), counted] }, '$costUsd'),
  };
}

const TOTAL_FIELDS = [
  'requests',
  'failedRequests',
  'costUsd',
  'creditsCharged',
  'units',
  'lastDayUsd',
  'trailingUsd',
] as const;

const sumFields = Object.fromEntries(TOTAL_FIELDS.map(field => [field, { $sum: `$${field}` }]));
const keepFields = Object.fromEntries(TOTAL_FIELDS.map(field => [field, 1]));

/**
 * One row per feature with any event in the scan window: totals, distinct acting users in
 * [from, to), and cost per UTC day. Grouping by (feature, user) first keeps the distinct-user
 * count a sum rather than an unbounded $addToSet.
 */
export function spendFeaturesPipeline(params: SpendFeaturesParams): PipelineStage[] {
  return [
    scanMatch(params),
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: { feature: '$feature', userId: { $ifNull: ['$userId', null] } },
              ...totalsAccumulators(params),
            },
          },
          {
            $group: {
              _id: '$_id.feature',
              ...sumFields,
              distinctUsers: {
                $sum: { $cond: [{ $and: [{ $gt: ['$requests', 0] }, { $ne: ['$_id.userId', null] }] }, 1, 0] },
              },
            },
          },
          { $project: { _id: 0, feature: '$_id', distinctUsers: 1, ...keepFields } },
        ],
        daily: [
          { $match: { $expr: { $and: [{ $gte: [effectiveUsageDate, params.from] }, counted] } } },
          {
            $group: {
              _id: {
                feature: '$feature',
                day: { $dateToString: { format: '%Y-%m-%d', date: effectiveUsageDate, timezone: 'UTC' } },
              },
              costUsd: { $sum: '$costUsd' },
            },
          },
          { $project: { _id: 0, feature: '$_id.feature', day: '$_id.day', costUsd: 1 } },
        ],
      },
    },
  ];
}

/**
 * One page of a feature's acting users by cost, with the user count and the feature's total
 * cost in the view. Users whose only events fall in the trailing window are left out.
 */
export function spendFeatureUsersPipeline(params: SpendFeatureUsersParams): PipelineStage[] {
  return [
    scanMatch(params),
    { $match: { ...attributedUsageMatch, userId: { $type: 'string' } } },
    { $group: { _id: '$userId', ...totalsAccumulators(params) } },
    { $match: { requests: { $gt: 0 } } },
    {
      $facet: {
        summary: [{ $group: { _id: null, users: { $sum: 1 }, costUsd: { $sum: '$costUsd' } } }],
        page: [
          // userId tiebreak keeps pages stable across equal-cost users.
          { $sort: { costUsd: -1, _id: 1 } },
          { $skip: params.offset },
          { $limit: params.limit },
          { $project: { _id: 0, userId: '$_id', ...keepFields } },
        ],
      },
    },
  ];
}

/** Distinct acting users in the scan window, for audience classification. */
export function spendActorIdsPipeline(params: SpendScanParams): PipelineStage[] {
  return [
    scanMatch(params),
    { $match: { ...attributedUsageMatch, userId: { $type: 'string' } } },
    { $group: { _id: '$userId' } },
  ];
}
