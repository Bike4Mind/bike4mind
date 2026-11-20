import type { AdminAiFeature } from '@bike4mind/common';
import { cacheRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { hasReportedUsage, type CompletionMeter } from '@bike4mind/services/billing/completionMeter';
import { resolvePlatformDecisionProviderKey } from '@bike4mind/server-utils/decisions/providers';
import { completionCeilingUsd, completionUsd } from '@bike4mind/server-utils/billing/meterPlatformCompletion';
import type { DecisionAccounting } from '@bike4mind/server-utils/decisions/executeDecision';
import { toMicroUsd } from '@bike4mind/server-utils/decisions/platformDecision';
import { AdminAiSkip } from './adminAiSkip';

/**
 * Platform spend for admin AI: a global cap per UTC calendar month shared by every feature, plus a
 * per-feature call cap and USD budget per fixed 24h window. Each call reserves its worst-case cost
 * first and settles to the actual cost after. A zero cap or budget refuses every call, free models
 * included (same rule as platformDecisionAccounting in packages/server-utils/src/decisions/platformDecision.ts).
 *
 * Never run inside withTransaction: Mongoose queries there join the transaction, so a refused claim
 * would abort it. Every cache write below opts out of an ambient session explicitly.
 */

export type AdminAiSpendLimits = { monthlyCapUsd: number; dailyBudgetUsd: number; maxCallsPerDay: number };

export type AdminAiReservation = {
  /** Charges `actualUsd` (clamped to the hold) and releases the rest. */
  settle(actualUsd: number): Promise<void>;
  /** Nothing reached the provider: releases the whole hold and the call. */
  refund(): Promise<void>;
  /** The provider was called but its cost is unknown: keeps the whole hold, so it can only under-spend. */
  fail(): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OUTSIDE_TXN = { outsideTransaction: true } as const;

const fromMicroUsd = (micro: number) => micro / 1_000_000;

export const adminAiMonthKey = (now: Date) =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

/** ms until the next UTC month starts, plus an hour so the window outlives the month it names. */
export const adminAiMonthWindowMs = (now: Date) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime() + HOUR_MS;

const callsKey = (feature: AdminAiFeature) => `adminAi:${feature}:calls`;
const dailySpendKey = (feature: AdminAiFeature) => `adminAi:${feature}:spendMicroUsd`;
const monthlySpendKey = (now: Date) => `adminAi:global:spendMicroUsd:${adminAiMonthKey(now)}`;

type Grant = { key: string; amount: number; expiresAt: Date };

// A failed release leaves spend over-counted, which can only refuse calls early, never overspend.
const release = (grants: Grant[]) =>
  Promise.allSettled(
    grants.map(g => cacheRepository.releaseFromFixedWindow(g.key, g.amount, g.expiresAt, OUTSIDE_TXN))
  );

/** Reserves one call and `maxCostUsd` against every window, or throws AdminAiSkip with nothing held. */
export async function reserveAdminAiSpend({
  feature,
  maxCostUsd,
  limits,
  now = new Date(),
}: {
  feature: AdminAiFeature;
  maxCostUsd: number;
  limits: AdminAiSpendLimits;
  now?: Date;
}): Promise<AdminAiReservation> {
  if (!(limits.monthlyCapUsd > 0) || !(limits.dailyBudgetUsd > 0)) throw new AdminAiSkip('budget');
  if (!(limits.maxCallsPerDay > 0)) throw new AdminAiSkip('call_cap');
  const spent = await readAdminAiSpend(feature, now);
  if (spent.spentThisMonthUsd >= limits.monthlyCapUsd || spent.spentTodayUsd >= limits.dailyBudgetUsd) {
    throw new AdminAiSkip('budget');
  }

  // A free request still needs an atomic claim below the spend cap; settlement releases this unit.
  const hold = Math.max(1, toMicroUsd(maxCostUsd));
  const granted: Grant[] = [];
  try {
    const calls = await cacheRepository.tryAddWithinLimitFixedWindow(
      callsKey(feature),
      1,
      limits.maxCallsPerDay,
      DAY_MS,
      OUTSIDE_TXN
    );
    if (!calls.success) throw new AdminAiSkip('call_cap');
    granted.push({ key: callsKey(feature), amount: 1, expiresAt: calls.expiresAt });

    const daily = await cacheRepository.tryAddWithinLimitFixedWindow(
      dailySpendKey(feature),
      hold,
      toMicroUsd(limits.dailyBudgetUsd),
      DAY_MS,
      OUTSIDE_TXN
    );
    if (!daily.success) throw new AdminAiSkip('budget');
    granted.push({ key: dailySpendKey(feature), amount: hold, expiresAt: daily.expiresAt });

    const monthly = await cacheRepository.tryAddWithinLimitFixedWindow(
      monthlySpendKey(now),
      hold,
      toMicroUsd(limits.monthlyCapUsd),
      adminAiMonthWindowMs(now),
      OUTSIDE_TXN
    );
    if (!monthly.success) throw new AdminAiSkip('budget');
    granted.push({ key: monthlySpendKey(now), amount: hold, expiresAt: monthly.expiresAt });
  } catch (error) {
    await release(granted);
    throw error;
  }

  const [callGrant, ...spendGrants] = granted;
  let closed = false;
  const close = () => {
    if (closed) return false;
    closed = true;
    return true;
  };

  return {
    settle: async actualUsd => {
      if (!close()) return;
      // A non-finite cost is unknown, so the full hold stays charged.
      if (!Number.isFinite(actualUsd)) return;
      const charged = Math.min(hold, Math.max(0, toMicroUsd(actualUsd)));
      await release(spendGrants.map(g => ({ ...g, amount: hold - charged })));
    },
    refund: async () => {
      if (!close()) return;
      await release([callGrant, ...spendGrants]);
    },
    fail: async () => {
      close();
    },
  };
}

export type AdminAiSpend = { callsToday: number; spentTodayUsd: number; spentThisMonthUsd: number };

/** Current window totals for one feature and the shared month; spend includes open holds. */
export async function readAdminAiSpend(feature: AdminAiFeature, now = new Date()): Promise<AdminAiSpend> {
  const count = async (key: string) => {
    const doc = await cacheRepository.findByKey(key);
    const value = (doc?.result as { count?: unknown } | undefined)?.count;
    return typeof value === 'number' ? value : 0;
  };
  const [calls, daily, monthly] = await Promise.all([
    count(callsKey(feature)),
    count(dailySpendKey(feature)),
    count(monthlySpendKey(now)),
  ]);
  return { callsToday: calls, spentTodayUsd: fromMicroUsd(daily), spentThisMonthUsd: fromMicroUsd(monthly) };
}

type AdapterParams = {
  feature: AdminAiFeature;
  limits: AdminAiSpendLimits;
  /** Receives each settled call's cost so the caller can record the total. */
  onCost?: (usd: number) => void;
  onCall?: (delta: number) => void;
  onUnknownCost?: () => void;
};

/** DecisionAccounting for executeDecision: platform keys only, admin AI budget, no user credits. */
export const adminAiDecisionAccounting = (
  { feature, limits, onCost, onCall, onUnknownCost }: AdapterParams,
  logger: Logger
): DecisionAccounting => ({
  resolveProviderKey: provider => resolvePlatformDecisionProviderKey(provider, logger),
  reserve: async ({ maxCostUsd }) => {
    const reservation = await reserveAdminAiSpend({ feature, maxCostUsd, limits });
    onCall?.(1);
    return {
      refund: () => {
        onCall?.(-1);
        return reservation.refund();
      },
      fail: () => {
        onUnknownCost?.();
        return reservation.fail();
      },
      settle: async usage => {
        await reservation.settle(usage.costUsd);
        onCost?.(usage.costUsd);
        return 0;
      },
    };
  },
});

/** CompletionMeter for meterCompletionBackend: holds the call's ceiling, settles to reported usage. */
export const adminAiCompletionMeter =
  ({ feature, limits, onCost, onCall, onUnknownCost }: AdapterParams): CompletionMeter =>
  async (modelInfo, messages, maxTokens, _models, turns = 1, tools = []) => {
    const ceilingUsd = completionCeilingUsd(modelInfo, messages, maxTokens, false, tools);
    const reservation = await reserveAdminAiSpend({ feature, maxCostUsd: ceilingUsd * turns, limits });
    onCall?.(1);
    return {
      // A throw before usage can follow a billed request; retain the hold while its cost is unknown.
      refund: () => {
        onUnknownCost?.();
        return reservation.fail();
      },
      settle: async usage => {
        // No reported usage: charge one turn's ceiling, as createRequestCompletionMeter does.
        const usd = hasReportedUsage(usage) ? completionUsd(modelInfo, usage) : ceilingUsd;
        await reservation.settle(usd);
        if (hasReportedUsage(usage)) onCost?.(usd);
        else onUnknownCost?.();
        return 0;
      },
    };
  };
