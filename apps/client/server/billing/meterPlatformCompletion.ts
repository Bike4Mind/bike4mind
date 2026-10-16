import { randomUUID } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import { getTextModelCost, getTurnsCost, type IMessage, type IUserDocument, type ModelInfo } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import type { CompletionInfo } from '@bike4mind/llm-adapters/backend';
import { estimateInputTokens } from '@bike4mind/services/cliCompletions';
import {
  createModelAdmission as createSharedModelAdmission,
  loadModelConfigurations,
  type ModelAdmission,
} from '@bike4mind/services/llm/modelAdmission';
import { getSettingsMap, getSettingsValue, usdToCredits, usdToCreditsStochastic } from '@bike4mind/utils';
import { getUserEntitlements } from '@server/entitlements';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
import { reserveRequestCredits, type CreditReservation } from '@server/billing/reserveRequestCredits';

/**
 * Metering for routes that run a text completion outside ChatCompletionInvoke (so nothing else
 * charges it). Call order at each site: admission, reserveCompletionCredits, provider call, then
 * settleCompletion on success or reservation.refund() on a throw.
 */

type MeteredRequest = Parameters<typeof reserveRequestCredits>[0]['req'] & {
  apiKeyInfo?: { keyId?: string };
  headers: IncomingHttpHeaders;
};

/**
 * Model admission for one user: delegates to the single implementation in
 * b4m-core/services/src/llm/modelAdmission.ts (shared with ChatCompletionInvoke, the fallback chain,
 * executeCompletion and the agent executor). Pass the resolved catalog so a disabled model, or an
 * unpriced text model while credits are enforced, is refused too.
 */
export async function createModelAdmission(user: IUserDocument, models?: ModelInfo[]): Promise<ModelAdmission> {
  const [configs, enforceCredits] = await Promise.all([
    loadModelConfigurations(adminSettingsRepository),
    isCreditsEnforced(),
  ]);
  return createSharedModelAdmission({
    user,
    configs,
    getEntitlements: () => getUserEntitlements(user),
    models,
    enforceCredits,
  });
}

/** Worst-case cost of one call: the full maxTokens, since settlement clamps to the hold. */
export function completionCeilingUsd(modelInfo: ModelInfo, messages: IMessage[], maxTokens: number): number {
  return getTextModelCost(modelInfo, estimateInputTokens(messages), maxTokens);
}

export async function isCreditsEnforced(): Promise<boolean> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  return Boolean(getSettingsValue('enforceCredits', settings));
}

/** Reserve `usd` against the caller's billing owner; a no-op hold when enforceCredits is off. */
export async function reserveCompletionCredits(
  req: MeteredRequest,
  usd: number,
  featureLabel: string
): Promise<CreditReservation> {
  return reserveRequestCredits({
    req,
    requiredCredits: usdToCredits(usd),
    enforceCredits: await isCreditsEnforced(),
    featureLabel,
  });
}

export type CompletionUsage = Pick<
  CompletionInfo,
  'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'turnUsage'
>;

/** Latch each usage field from whichever chunk carries it (same contract as cliCompletions). */
export function latchUsage(usage: CompletionUsage, info?: CompletionInfo): void {
  if (info?.inputTokens) usage.inputTokens = info.inputTokens;
  if (info?.outputTokens) usage.outputTokens = info.outputTokens;
  if (info?.cacheReadInputTokens) usage.cacheReadInputTokens = info.cacheReadInputTokens;
  if (info?.cacheCreationInputTokens) usage.cacheCreationInputTokens = info.cacheCreationInputTokens;
  if (info?.turnUsage?.length) usage.turnUsage = info.turnUsage;
}

/** Same pricing rule as cliCompletions' settledUsdCost. */
export function completionUsd(modelInfo: ModelInfo, usage: CompletionUsage): number {
  return usage.turnUsage?.length
    ? getTurnsCost(modelInfo, usage.turnUsage)
    : getTextModelCost(
        modelInfo,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.cacheReadInputTokens ?? 0,
        usage.cacheCreationInputTokens ?? 0
      );
}

/** Charge `usd` (capped at the hold) with one completion_api_usage row; 0 refunds with no row. */
export function settleCompletion(
  reservation: CreditReservation,
  req: MeteredRequest,
  charge: { model: string; usd: number; inputTokens: number; outputTokens: number; sessionId?: string }
): Promise<number> {
  return reservation.settle(usdToCreditsStochastic(charge.usd), {
    type: 'completion_api_usage',
    sessionId: charge.sessionId ?? randomUUID(),
    model: charge.model,
    apiKeyId: req.apiKeyInfo?.keyId,
    // Web JWT calls keep the ledger default; resolveRequestUsageSource would label them 'api'.
    source: req.apiKeyInfo ? resolveRequestUsageSource(req) : undefined,
    inputTokens: charge.inputTokens,
    outputTokens: charge.outputTokens,
  });
}
