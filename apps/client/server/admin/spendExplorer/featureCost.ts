import { adminSettingsRepository, usageEventRepository } from '@bike4mind/database';
import {
  CreditHolderType,
  DEFAULT_FEATURE_SPIKE_MULTIPLE,
  FEATURE_SPIKE_TRAILING_DAYS,
  FEATURE_UNIT_LABELS,
  featureSpikeEnd,
  isFeatureSpendSpike,
  type SpendActorScanParams,
  type SpendAudience,
  type SpendFeatureAggregate,
  type SpendFeatureRow,
  type SpendFeaturesParams,
  type SpendFeaturesResponse,
  type SpendFeatureUsersResponse,
} from '@bike4mind/common';
import { isCountedUser, loadCountingContext, loadUserFlags } from '@bike4mind/server-utils/analytics/signupCohort';
import { resolveAccountInfo } from './spendExplorer';

const MAX_TIME_MS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The userId filter for an audience. Internal is decided per acting user by the Analytics
 * tab's `isCountedUser`, so both pages split accounts the same way. It runs over the users
 * active in the scan window, so the internal set stays small enough to inline into $in / $nin.
 */
export async function loadAudienceFilter(
  audience: SpendAudience,
  scan: SpendActorScanParams
): Promise<SpendFeaturesParams['userFilter']> {
  if (audience === 'all') return undefined;
  const [actorIds, ctx] = await Promise.all([usageEventRepository.spendActorIds(scan), loadCountingContext()]);
  const flags = await loadUserFlags(actorIds, MAX_TIME_MS);
  const internalIds = actorIds.filter(id => !isCountedUser(flags.get(id), ctx));
  return { mode: audience === 'internal' ? 'include' : 'exclude', userIds: internalIds };
}

/** The admin setting, or its default while it has never been saved. */
export async function loadSpikeMultiple(): Promise<number> {
  const saved = await adminSettingsRepository.getSettingsValue('spendExplorerFeatureSpikeMultiple');
  return saved ?? DEFAULT_FEATURE_SPIKE_MULTIPLE;
}

/** Every UTC day in [from, to), as `YYYY-MM-DD`. `from` and `to` sit on day boundaries. */
export function daysOf(from: Date, to: Date): string[] {
  const days: string[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

const trailingAvg = (trailingUsd: number) => trailingUsd / FEATURE_SPIKE_TRAILING_DAYS;

/**
 * Aggregates into table rows: share, unit label, spike flag and a dense daily series; largest cost first.
 * Cost is the recorded `UsageEvent.costUsd`. A per-vendor plan-credit conversion belongs here
 * as an extra per-row field keyed by feature and units, not as a replacement for costUsd.
 */
export function shapeFeatureRows(
  aggregates: SpendFeatureAggregate[],
  { days, spikeMultiple }: { days: string[]; spikeMultiple: number }
): { totalCostUsd: number; features: SpendFeatureRow[] } {
  // Features whose only events fell in the trailing window have nothing in range to show.
  const inRange = aggregates.filter(row => row.requests > 0);
  const totalCostUsd = inRange.reduce((sum, row) => sum + row.costUsd, 0);
  const features = inRange.map(({ daily, trailingUsd, ...row }): SpendFeatureRow => {
    const byDay = new Map(daily.map(d => [d.day, d.costUsd]));
    const trailingAvgUsd = trailingAvg(trailingUsd);
    return {
      ...row,
      share: totalCostUsd > 0 ? row.costUsd / totalCostUsd : 0,
      unitLabel: FEATURE_UNIT_LABELS[row.feature] ?? null,
      trailingAvgUsd,
      isSpike: isFeatureSpendSpike({ lastDayUsd: row.lastDayUsd, trailingAvgUsd }, spikeMultiple),
      dailyUsd: days.map(day => byDay.get(day) ?? 0),
    };
  });
  features.sort((a, b) => b.costUsd - a.costUsd || a.feature.localeCompare(b.feature));
  return { totalCostUsd, features };
}

export type FeaturesQuery = { from: Date; to: Date; audience: SpendAudience; actorUserId?: string };

/** `from`/`to` must already sit on UTC day boundaries. */
export async function buildFeatures(query: FeaturesQuery): Promise<SpendFeaturesResponse> {
  const { from, to, audience, actorUserId } = query;
  const spikeEnd = featureSpikeEnd(to, new Date());
  const [userFilter, spikeMultiple] = await Promise.all([
    loadAudienceFilter(audience, { from, to, spikeEnd }),
    loadSpikeMultiple(),
  ]);
  const aggregates = await usageEventRepository.spendFeatures({ from, to, spikeEnd, actorUserId, userFilter });
  const days = daysOf(from, to);
  const { totalCostUsd, features } = shapeFeatureRows(aggregates, { days, spikeMultiple });
  return {
    audience,
    totalCostUsd,
    spikeMultiple,
    lastDayStart: new Date(spikeEnd.getTime() - DAY_MS).toISOString(),
    days,
    features,
  };
}

export type FeatureUsersQuery = {
  from: Date;
  to: Date;
  audience: SpendAudience;
  feature: string;
  limit: number;
  offset: number;
};

export async function buildFeatureUsers(query: FeatureUsersQuery): Promise<SpendFeatureUsersResponse> {
  const { from, to, audience, feature, limit, offset } = query;
  const spikeEnd = featureSpikeEnd(to, new Date());
  const [userFilter, spikeMultiple] = await Promise.all([
    loadAudienceFilter(audience, { from, to, spikeEnd, feature }),
    loadSpikeMultiple(),
  ]);
  const page = await usageEventRepository.spendFeatureUsers({
    from,
    to,
    spikeEnd,
    feature,
    limit,
    offset,
    userFilter,
  });
  const info = await resolveAccountInfo(page.users.map(user => ({ id: user.userId, type: CreditHolderType.User })));
  return {
    feature,
    audience,
    unitLabel: FEATURE_UNIT_LABELS[feature] ?? null,
    featureCostUsd: page.featureCostUsd,
    totalUsers: page.totalUsers,
    spikeMultiple,
    users: page.users.map(({ trailingUsd, ...user }) => {
      const trailingAvgUsd = trailingAvg(trailingUsd);
      return {
        ...user,
        // Unresolved ids (agent pools, legacy ids) show raw.
        name: info.get(user.userId)?.name ?? user.userId,
        share: page.featureCostUsd > 0 ? user.costUsd / page.featureCostUsd : 0,
        trailingAvgUsd,
        isSpike: isFeatureSpendSpike({ lastDayUsd: user.lastDayUsd, trailingAvgUsd }, spikeMultiple),
      };
    }),
  };
}
