import type { ICacheRepository, IDataLakeBatchRepository, IDataLakeRepository, SettingScope } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** The lake owner a period reservation is charged to - the shape `scopeForLake` derives. */
export type LakeSpendOwner = NonNullable<SettingScope['owner']>;

/**
 * Cache key for one owner's period window. Keyed by owner TYPE as well as id so a user id and an
 * organization id can never share a window, however the two id spaces happen to overlap.
 */
export const ownerEmbeddingSpendKey = (owner: LakeSpendOwner): string =>
  `dataLakeEmbeddingSpend:owner:${owner.type}:${owner.id}`;

export type OwnerSpendReservation =
  | { granted: true }
  /**
   * `stuck` marks a denial that cannot clear inside the current window (the budget is 0, or this
   * one call alone exceeds it), so the caller must not promise automatic resumption.
   */
  | { granted: false; stuck: boolean; windowEndsAt: Date };

/**
 * Reserve-first against one lake owner's share of the period window. Same window length as the
 * platform period meter (each fixed window starts at its own key's first write).
 *
 * The owner is the lake's owner, never the actor who triggered the run: an upload into an org lake
 * draws on the org's share, matching the cost tier the gate already applies (see scopeForLake).
 * Called by enforceEmbeddingSpendGate between the per-lake and platform-period checks.
 */
export async function reserveOwnerEmbeddingSpend(params: {
  owner: LakeSpendOwner;
  estimatedMicroUsd: number;
  budgetMicroUsd: number;
  periodHours: number;
  cache: Pick<ICacheRepository, 'tryAddWithinLimitFixedWindow'>;
}): Promise<OwnerSpendReservation> {
  const { owner, estimatedMicroUsd, budgetMicroUsd, periodHours, cache } = params;
  const window = await cache.tryAddWithinLimitFixedWindow(
    ownerEmbeddingSpendKey(owner),
    estimatedMicroUsd,
    budgetMicroUsd,
    periodHours * 3_600_000
  );
  if (window.success) return { granted: true };
  return {
    granted: false,
    stuck: budgetMicroUsd <= 0 || estimatedMicroUsd > budgetMicroUsd,
    windowEndsAt: window.expiresAt,
  };
}

/** Returns an owner reservation to its window. Best-effort: a failure is logged, never thrown. */
export async function releaseOwnerEmbeddingSpend(params: {
  owner: LakeSpendOwner;
  estimatedMicroUsd: number;
  cache: Pick<ICacheRepository, 'releaseFromFixedWindow'>;
  logger?: Logger;
}): Promise<void> {
  const { owner, estimatedMicroUsd, cache, logger } = params;
  try {
    await cache.releaseFromFixedWindow(ownerEmbeddingSpendKey(owner), estimatedMicroUsd);
  } catch (error) {
    logger?.warn?.('[spendGate] could not release the owner window reservation:', error);
  }
}

/**
 * Gives back the run and lake reservations a message made before the owner or period window denied it. The
 * owner window resets, but the per-lake meter is lifetime, so without this a paused owner's lake
 * would fill up with spend that never ran and stay blocked after the window resets. Best-effort,
 * like the worker's release after a provider failure (fabFileVectorize).
 */
export async function releaseReservationsAfterOwnerDenial(params: {
  estimatedMicroUsd: number;
  batchId?: string;
  dataLakeId?: string;
  dataLakes: Pick<IDataLakeRepository, 'releaseEmbeddingSpend'>;
  dataLakeBatches: Pick<IDataLakeBatchRepository, 'releaseEmbeddingSpend'>;
  logger?: Logger;
}): Promise<void> {
  const { estimatedMicroUsd, batchId, dataLakeId, dataLakes, dataLakeBatches, logger } = params;
  try {
    if (batchId) await dataLakeBatches.releaseEmbeddingSpend(batchId, estimatedMicroUsd);
    if (dataLakeId) await dataLakes.releaseEmbeddingSpend(dataLakeId, estimatedMicroUsd);
  } catch (error) {
    logger?.warn?.('[spendGate] could not release reservations after an owner-window denial:', error);
  }
}
