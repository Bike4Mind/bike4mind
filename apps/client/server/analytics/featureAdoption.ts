import type { PipelineStage } from 'mongoose';
import { UsageEvent } from '@bike4mind/database';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import {
  isCountedUser,
  loadCountingContext,
  loadUserFlags,
  type CountingContext,
  type UserFlags,
} from '@bike4mind/server-utils/analytics/signupCohort';
import {
  ADOPTION_FEATURES,
  ADOPTION_LABELS,
  type FeatureAdoption,
  type FeatureAdoptionQuery,
} from '@client/app/utils/featureAdoption';
import { formatDay, shiftDay } from './analyticsRollup';

const DEADLINE_MS = 15_000;
export const ADOPTION_GROUP_LIMIT = 5000;
export class FeatureAdoptionQueryError extends Error {}
export class FeatureAdoptionCapacityError extends Error {}

export function adoptionWindow(query: FeatureAdoptionQuery, now: Date): FeatureAdoption['window'] {
  const today = formatDay(now);
  const to = query.end ?? shiftDay(today, -1);
  try {
    if (shiftDay(to, 0) !== to || to >= today) throw new Error();
  } catch {
    throw new FeatureAdoptionQueryError('End date must be a valid complete UTC day before today.');
  }
  const from = shiftDay(to, 1 - query.days);
  return { from, to, previousFrom: shiftDay(from, -query.days), previousTo: shiftDay(from, -1) };
}

export type AdoptionGroup = {
  _id: { userId: string; feature: (typeof ADOPTION_FEATURES)[number]; previous: boolean };
  operations: number;
};

export function adoptionPipeline(query: FeatureAdoptionQuery, window: FeatureAdoption['window']): PipelineStage[] {
  return [
    {
      $match: {
        status: 'ok',
        feature: { $in: [...ADOPTION_FEATURES] },
        source: { $ne: 'system' },
        requestId: { $type: 'string', $ne: '' },
        userId: { $type: 'string', $ne: '' },
        'run.role': { $ne: 'worker' },
        'run.purpose': { $nin: ['title', 'compaction', 'suggestion', 'explore', 'review'] },
        'requestMeta.operation': { $exists: false },
        createdAt: {
          $gte: new Date(`${window.previousFrom}T00:00:00Z`),
          $lt: new Date(`${shiftDay(window.to, 1)}T00:00:00Z`),
        },
      },
    },
    // A retry crossing the period boundary belongs to its first successful settlement in the read window.
    {
      $group: {
        _id: { userId: '$userId', feature: '$feature', requestId: '$requestId' },
        at: { $min: '$createdAt' },
        sources: { $addToSet: { $ifNull: ['$source', 'unknown'] } },
      },
    },
    {
      $addFields: {
        client: { $cond: [{ $eq: [{ $size: '$sources' }, 1] }, { $arrayElemAt: ['$sources', 0] }, 'unknown'] },
      },
    },
    ...(query.client === 'all' ? [] : [{ $match: { client: query.client } }]),
    {
      $group: {
        _id: {
          userId: '$_id.userId',
          feature: '$_id.feature',
          previous: { $lt: ['$at', new Date(`${window.from}T00:00:00Z`)] },
        },
        operations: { $sum: 1 },
      },
    },
    { $limit: ADOPTION_GROUP_LIMIT + 1 },
  ];
}

export function summarizeAdoption(
  query: FeatureAdoptionQuery,
  window: FeatureAdoption['window'],
  groups: AdoptionGroup[],
  users: Map<string, UserFlags>,
  context: CountingContext
): FeatureAdoption {
  if (groups.length > ADOPTION_GROUP_LIMIT) {
    throw new FeatureAdoptionCapacityError('Too many user groups. Choose a shorter period or a single client.');
  }
  const eligible = groups.filter(group => {
    const user = users.get(group._id.userId);
    if (user && aiAccessDeniedMessage(user) !== null) return false;
    const external = isCountedUser(user, context);
    return query.accounts === 'all' || external === (query.accounts === 'external');
  });
  const features = ADOPTION_FEATURES.map(feature => {
    const contributions = new Map<string, { userId: string; operations: number; previousOperations: number }>();
    for (const group of eligible.filter(row => row._id.feature === feature)) {
      const row = contributions.get(group._id.userId) ?? {
        userId: group._id.userId,
        operations: 0,
        previousOperations: 0,
      };
      if (group._id.previous) row.previousOperations += group.operations;
      else row.operations += group.operations;
      contributions.set(row.userId, row);
    }
    const rows = [...contributions.values()].sort((a, b) => a.userId.localeCompare(b.userId));
    const successfulUsers = rows.filter(row => row.operations > 0).length;
    const previousUsers = rows.filter(row => row.previousOperations > 0).length || null;
    return {
      feature,
      label: ADOPTION_LABELS[feature],
      successfulUsers,
      previousUsers,
      userChange: previousUsers === null ? null : successfulUsers - previousUsers,
      successfulOperations: rows.reduce((sum, row) => sum + row.operations, 0),
      repeatUsers:
        previousUsers === null ? null : rows.filter(row => row.operations > 0 && row.previousOperations > 0).length,
      repeatDenominator: previousUsers,
      users: rows,
    };
  });
  return { query, window, coverage: 'unknown', features };
}

export async function getFeatureAdoption(query: FeatureAdoptionQuery, now = new Date()): Promise<FeatureAdoption> {
  const window = adoptionWindow(query, now);
  const [groups, context] = await Promise.all([
    UsageEvent.aggregate<AdoptionGroup>(adoptionPipeline(query, window))
      .allowDiskUse(true)
      .option({ maxTimeMS: DEADLINE_MS }),
    loadCountingContext(),
  ]);
  if (groups.length > ADOPTION_GROUP_LIMIT) {
    throw new FeatureAdoptionCapacityError('Too many user groups. Choose a shorter period or a single client.');
  }
  const users = await loadUserFlags([...new Set(groups.map(group => group._id.userId))], DEADLINE_MS);
  return summarizeAdoption(query, window, groups, users, context);
}
