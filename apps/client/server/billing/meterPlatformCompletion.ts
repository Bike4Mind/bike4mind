import { randomUUID } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import {
  getTextModelCost,
  getTurnsCost,
  insufficientCreditsError,
  type IMessage,
  type IUserDocument,
  type ModelInfo,
} from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, usageEventRepository } from '@bike4mind/database';
import { estimateInputTokens } from '@bike4mind/services/cliCompletions';
import {
  assertOwnerHasCredits,
  creditService,
  latchUsage,
  type CompletionMeter,
  type CompletionUsage,
} from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
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
  featureLabel: string,
  organizationId?: string | null
): Promise<CreditReservation> {
  return reserveRequestCredits({
    req,
    requiredCredits: usdToCredits(usd),
    enforceCredits: await isCreditsEnforced(),
    featureLabel,
    organizationId,
  });
}

export { latchUsage, type CompletionUsage };

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

/**
 * Charge `usd` (capped at the hold) with one completion_api_usage ledger row (0 refunds with no row),
 * then record one UsageEvent with the credits actually charged. The event never fails the request.
 */
export async function settleCompletion(
  reservation: CreditReservation,
  req: MeteredRequest,
  charge: {
    model: string;
    provider: string;
    usd: number;
    inputTokens: number;
    outputTokens: number;
    sessionId?: string;
  }
): Promise<number> {
  const requestId = charge.sessionId ?? randomUUID();
  const source = req.apiKeyInfo ? resolveRequestUsageSource(req) : undefined;
  const creditsCharged = await reservation.settle(usdToCreditsStochastic(charge.usd), {
    type: 'completion_api_usage',
    sessionId: requestId,
    model: charge.model,
    apiKeyId: req.apiKeyInfo?.keyId,
    // Web JWT calls keep the ledger default; resolveRequestUsageSource would label them 'api'.
    source,
    inputTokens: charge.inputTokens,
    outputTokens: charge.outputTokens,
  });
  await usageEventRepository
    .record({
      requestId,
      userId: req.user!.id,
      ownerId: reservation.ownerId,
      ownerType: reservation.ownerType,
      sessionId: charge.sessionId,
      feature: 'completion_api',
      provider: charge.provider,
      model: charge.model,
      inputTokens: charge.inputTokens,
      outputTokens: charge.outputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      settledBasis: 'local',
      costUsd: charge.usd,
      creditsCharged,
      status: 'ok',
      source,
      apiKeyId: req.apiKeyInfo?.keyId,
    })
    .catch(err => req.logger.warn('[meterPlatformCompletion] usage event failed', err));
  return creditsCharged;
}

/**
 * A CompletionMeter (b4m-core/services/src/billing/completionMeter.ts) for platform-key work with no
 * HTTP request (queue workers, crons, mission wakes): admits the model for `user`, reserves the
 * ceiling against the billing owner (`opts.organizationId` when given, else the user's org seat when
 * present, else the user), and settles through
 * settleCompletion. Throws a 422 insufficient_credits when the owner cannot cover the hold.
 */
export function createCompletionMeter(
  user: IUserDocument,
  logger: Logger,
  featureLabel: string,
  opts: { sessionId?: string; organizationId?: string | null } = {}
): CompletionMeter {
  const req = { user, logger, headers: {} };
  return async (modelInfo, messages, maxTokens, models) => {
    await (await createModelAdmission(user, models)).assert(modelInfo.id);
    const ceilingUsd = completionCeilingUsd(modelInfo, messages, maxTokens);
    const reservation = await reserveCompletionCredits(req, ceilingUsd, featureLabel, opts.organizationId);
    return {
      refund: () => reservation.refund(),
      settle: usage =>
        settleCompletion(reservation, req, {
          model: modelInfo.id,
          provider: modelInfo.backend,
          // No reported usage means the adapter could not count it; charge the hold rather than nothing.
          usd:
            usage.inputTokens || usage.outputTokens || usage.turnUsage?.length
              ? completionUsd(modelInfo, usage)
              : ceilingUsd,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          sessionId: opts.sessionId,
        }),
    };
  };
}

/**
 * Pre-enqueue gate for queued platform-key work billed later through createCompletionMeter: refuses
 * (422 insufficient_credits) when the billing owner - the org seat when present, else the user - has
 * no credits or the member is at their org cap. A no-op when enforceCredits is off.
 */
export async function assertOwnerCanAfford(user: IUserDocument): Promise<void> {
  if (!(await isCreditsEnforced())) return;
  const org = user.organizationId ? await organizationRepository.findById(String(user.organizationId)) : null;
  if (org && creditService.isMemberAtOrOverCap(org, user.id)) {
    throw insufficientCreditsError(creditService.MEMBER_CREDIT_CAP_MESSAGE);
  }
  assertOwnerHasCredits(org ?? user);
}
