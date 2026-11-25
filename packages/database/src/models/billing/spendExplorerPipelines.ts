import type { PipelineStage } from 'mongoose';
import {
  attributedUsageMatch,
  effectiveUsageDate,
  platformUsageExpression,
  usageTimeMatch,
} from './platformUsageReporting';
import {
  UNCLASSIFIED_SOURCE,
  type SpendBreakdownParams,
  SPEND_EXPLORER_MAX_PAYERS,
  type SpendBucketSize,
  type SpendSegmentIds,
  type SpendSplitDimension,
  type SpendTimelineParams,
} from '@bike4mind/common';

/**
 * Aggregation pipelines behind the admin Spend explorer
 * (UsageEventRepository.spendTimeline / spendBreakdown). Kept apart from the
 * repository so the expression builders can be read and tested on their own.
 */

const BUCKET_FORMAT: Record<SpendBucketSize, string> = { hour: '%Y-%m-%dT%H', day: '%Y-%m-%d' };

// Old rows lack executed*, so always coalesce to the requested provider/model.
export const EXECUTED_MODEL_GROUP_KEY = {
  executedProvider: { $ifNull: ['$executedProvider', '$provider'] },
  executedModel: { $ifNull: ['$executedModel', '$model'] },
} as const;

// Providers invoice the model that ran, so key on the executed provider.
const EXECUTED_PROVIDER = EXECUTED_MODEL_GROUP_KEY.executedProvider;

export function segmentExpression(ids: SpendSegmentIds): Record<string, unknown> {
  return {
    $switch: {
      branches: [
        { case: platformUsageExpression, then: 'platform' },
        { case: { $in: ['$userId', ids.internal] }, then: 'internal' },
        { case: { $in: ['$userId', ids.partner] }, then: 'partner' },
        { case: { $in: ['$ownerId', ids.internal] }, then: 'internal' },
        { case: { $in: ['$ownerId', ids.partner] }, then: 'partner' },
      ],
      default: 'customer',
    },
  };
}

function splitKeyExpression(splitBy: Exclude<SpendSplitDimension, 'funding'>, ids: SpendSegmentIds): unknown {
  switch (splitBy) {
    case 'provider':
      return EXECUTED_PROVIDER;
    case 'model':
      return { $ifNull: ['$executedModel', '$model'] };
    case 'feature':
      return '$feature';
    case 'source':
      return { $ifNull: ['$source', UNCLASSIFIED_SOURCE] };
    case 'segment':
      return segmentExpression(ids);
  }
}

function matchStage(params: { from: Date; to: Date; actorUserId?: string }): PipelineStage.Match {
  // Half-open [from, to), like spendSummary, so adjacent windows never double count.
  const match = usageTimeMatch(params.from, params.to);
  if (params.actorUserId) match.userId = params.actorUserId;
  return { $match: match };
}

/**
 * Funding split: each event's cost apportioned by the credits its fundingBreakdown
 * drew from each source. Granted is free credit; purchased and subscription are
 * paid. Attributed events with no breakdown, or a zero one, land wholly in `unknown`.
 */
function fundingPipeline(bucketExpr: unknown): PipelineStage[] {
  const part = (field: string) => ({ $ifNull: [`$fundingBreakdown.${field}`, 0] });
  const fundedTotal = {
    $add: [part('granted'), part('purchased'), part('subscription'), part('unknown')],
  };
  const shareOf = (credits: unknown) => ({
    $cond: [{ $gt: ['$$fundedTotal', 0] }, { $multiply: ['$costUsd', { $divide: [credits, '$$fundedTotal'] }] }, 0],
  });
  return [
    {
      $project: {
        bucket: bucketExpr,
        parts: {
          $let: {
            vars: { fundedTotal },
            in: {
              $cond: [
                platformUsageExpression,
                [{ key: 'platform', costUsd: '$costUsd', requests: 1 }],
                [
                  { key: 'granted', costUsd: shareOf(part('granted')), requests: 1 },
                  {
                    key: 'paid',
                    costUsd: shareOf({ $add: [part('purchased'), part('subscription')] }),
                    requests: 0,
                  },
                  {
                    key: 'unknown',
                    costUsd: {
                      $cond: [{ $gt: ['$$fundedTotal', 0] }, shareOf(part('unknown')), '$costUsd'],
                    },
                    requests: 0,
                  },
                ],
              ],
            },
          },
        },
      },
    } as PipelineStage,
    { $unwind: '$parts' },
    {
      $group: {
        _id: { bucket: '$bucket', key: '$parts.key' },
        costUsd: { $sum: '$parts.costUsd' },
        requests: { $sum: '$parts.requests' },
      },
    },
  ];
}

/**
 * Cost per (bucket, series key) over [from, to). One row per non-empty pair;
 * the caller fills empty buckets and folds small series.
 */
export function spendTimelinePipeline(params: SpendTimelineParams): PipelineStage[] {
  const bucketExpr = {
    $dateToString: { format: BUCKET_FORMAT[params.bucket], date: effectiveUsageDate, timezone: 'UTC' },
  };
  const grouped: PipelineStage[] =
    params.splitBy === 'funding'
      ? fundingPipeline(bucketExpr)
      : [
          {
            $group: {
              _id: { bucket: bucketExpr, key: splitKeyExpression(params.splitBy, params.segmentIds) },
              costUsd: { $sum: '$costUsd' },
              requests: { $sum: 1 },
            },
          },
        ];
  return [
    matchStage(params),
    ...grouped,
    { $project: { _id: 0, bucket: '$_id.bucket', key: '$_id.key', costUsd: 1, requests: 1 } },
    { $sort: { bucket: 1, key: 1 } },
  ];
}

/** Totals, provider and segment cuts, and the top `limit` accounts over [from, to), in one scan. */
export function spendBreakdownPipeline(params: SpendBreakdownParams): PipelineStage[] {
  return [
    matchStage(params),
    {
      $facet: {
        totals: [{ $group: { _id: null, costUsd: { $sum: '$costUsd' } } }],
        byProvider: [
          { $group: { _id: EXECUTED_PROVIDER, costUsd: { $sum: '$costUsd' } } },
          { $project: { _id: 0, provider: '$_id', costUsd: 1 } },
          { $sort: { costUsd: -1, provider: 1 } },
        ],
        bySegment: [
          { $group: { _id: segmentExpression(params.segmentIds), costUsd: { $sum: '$costUsd' } } },
          { $project: { _id: 0, segment: '$_id', costUsd: 1 } },
          { $sort: { costUsd: -1, segment: 1 } },
        ],
        // Keyed on the acting user, not the owner: team-plan spend bills to the org, and the
        // person who ran the calls must still show up. Payers ride along, largest first.
        topActors: [
          { $match: { ...attributedUsageMatch, userId: { $type: 'string' }, ownerId: { $type: 'string' } } },
          {
            $group: {
              _id: { userId: '$userId', ownerId: '$ownerId', ownerType: '$ownerType' },
              costUsd: { $sum: '$costUsd' },
              requests: { $sum: 1 },
            },
          },
          { $sort: { costUsd: -1, '_id.ownerId': 1 } },
          {
            $group: {
              _id: '$_id.userId',
              costUsd: { $sum: '$costUsd' },
              requests: { $sum: '$requests' },
              payers: { $push: { ownerId: '$_id.ownerId', ownerType: '$_id.ownerType', costUsd: '$costUsd' } },
            },
          },
          {
            $project: {
              _id: 0,
              userId: '$_id',
              costUsd: 1,
              requests: 1,
              payers: { $slice: ['$payers', SPEND_EXPLORER_MAX_PAYERS] },
            },
          },
          // userId tiebreak keeps the cap deterministic across equal-cost actors.
          { $sort: { costUsd: -1, userId: 1 } },
          { $limit: params.limit },
        ],
      },
    },
  ];
}
