import { randomUUID } from 'crypto';
import {
  geminiThinkingOutputCap,
  usesGeminiThinkingOutputCap,
  type ICompletionOptionTools,
} from '@bike4mind/llm-adapters';
import { hasReportedUsage } from '@bike4mind/services/billing/completionMeter';
import type { IncomingHttpHeaders } from 'http';
import {
  getTextModelCost,
  getTurnsCost,
  insufficientCreditsError,
  type IMessage,
  type IUserDocument,
  type ModelInfo,
  type ApiKeyCompletionSource,
} from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, usageEventRepository } from '@bike4mind/database';
import { estimateInputTokens, estimateToolTokens } from '@bike4mind/services/cliCompletions';
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
  loadFreeTierAllowedModels,
  loadModelConfigurations,
  type ModelAdmission,
} from '@bike4mind/services/llm/modelAdmission';
import { getSettingsMap, getSettingsValue, usdToCredits, usdToCreditsStochastic } from '@bike4mind/utils';
import { assertApiKeyOrgMembership } from '@bike4mind/server-utils/billing/assertApiKeyOrgMembership';
import { getUserEntitlements } from '@server/entitlements';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
import {
  reserveRequestCredits,
  resolveRequestBillingOrgId,
  type CreditReservation,
} from '@server/billing/reserveRequestCredits';

/**
 * Metering for routes that run a text completion outside ChatCompletionInvoke (so nothing else
 * charges it). Call order at each site: admission, reserveCompletionCredits, provider call, then
 * settleCompletion on success or reservation.refund() on a throw.
 */

export type MeteredRequest = Parameters<typeof reserveRequestCredits>[0]['req'] & {
  apiKeyInfo?: { keyId?: string };
  headers: IncomingHttpHeaders;
  /** Captured source for asynchronous work whose original request is no longer available. */
  usageSource?: ApiKeyCompletionSource;
};

/**
 * Model admission for one user: delegates to the single implementation in
 * b4m-core/services/src/llm/modelAdmission.ts (shared with ChatCompletionInvoke, the fallback chain,
 * executeCompletion and the agent executor). Pass the resolved catalog so a disabled model, or an
 * unpriced text model while credits are enforced, is refused too. `systemModel` skips the per-user
 * picker access rules and the free-tier gate for a model the platform chose (the operations model, a fixed default).
 */
export async function createModelAdmission(
  user: IUserDocument,
  models?: ModelInfo[],
  systemModel = false
): Promise<ModelAdmission> {
  const [configs, enforceCredits, freeTierAllowedModels] = await Promise.all([
    systemModel ? [] : loadModelConfigurations(adminSettingsRepository),
    isCreditsEnforced(),
    systemModel ? undefined : loadFreeTierAllowedModels(adminSettingsRepository),
  ]);
  return createSharedModelAdmission({
    user,
    configs,
    getEntitlements: () => getUserEntitlements(user),
    models,
    enforceCredits,
    freeTierAllowedModels,
  });
}

/**
 * Worst-case cost of one call: the full maxTokens, since settlement clamps to the hold. With
 * `cacheWrites` (the request carries a cache breakpoint) every input token is priced as a cache write.
 */
export function completionCeilingUsd(
  modelInfo: ModelInfo,
  messages: IMessage[],
  maxTokens: number,
  cacheWrites = false,
  tools: ICompletionOptionTools[] = []
): number {
  const inputTokens = estimateInputTokens(messages) + (tools.length > 0 ? estimateToolTokens(tools, false) : 0);
  return cacheWrites
    ? getTextModelCost(modelInfo, 0, maxTokens, 0, inputTokens, inputTokens)
    : getTextModelCost(modelInfo, inputTokens, maxTokens);
}

/** Price a direct backend call's full provider output budget, including Gemini thinking headroom. */
export function completionRequestCeilingUsd(
  modelInfo: ModelInfo,
  messages: IMessage[],
  maxTokens: number,
  tools: ICompletionOptionTools[] = []
): number {
  const providerMaxTokens = usesGeminiThinkingOutputCap(modelInfo)
    ? geminiThinkingOutputCap(modelInfo, maxTokens).maxOutputTokens
    : maxTokens;
  return completionCeilingUsd(modelInfo, messages, providerMaxTokens, false, tools);
}

export async function isCreditsEnforced(): Promise<boolean> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits'], skipCache: true }
  );
  return Boolean(getSettingsValue('enforceCredits', settings));
}

/** Reserve `usd` against the caller's billing owner; a no-op hold when enforceCredits is off. */
export async function reserveCompletionCredits(
  req: MeteredRequest,
  usd: number,
  featureLabel: string,
  { organizationId, holdTtlMs }: { organizationId?: string | null; holdTtlMs?: number } = {}
): Promise<CreditReservation> {
  return reserveRequestCredits({
    req,
    // Positive requests keep the minimum one-credit reservation; an explicitly free call needs none.
    requiredCredits: usd === 0 ? 0 : usdToCredits(usd),
    enforceCredits: await isCreditsEnforced(),
    featureLabel,
    billingOrganizationId: organizationId,
    holdTtlMs,
  });
}

export { hasReportedUsage, latchUsage, type CompletionUsage };

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
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    sessionId?: string;
    feature?: 'completion_api' | 'embedding';
  }
): Promise<number> {
  // Per call, never the session id: UsageEvent rollups group by requestId, so one id shared across a
  // session's calls would merge them.
  const requestId = randomUUID();
  const source = req.apiKeyInfo ? (req.usageSource ?? resolveRequestUsageSource(req)) : undefined;
  const creditsCharged = await reservation.settle(usdToCreditsStochastic(charge.usd), {
    type: 'completion_api_usage',
    sessionId: charge.sessionId ?? requestId,
    model: charge.model,
    apiKeyId: req.apiKeyInfo?.keyId,
    // Web JWT calls keep the ledger's 'web' default; resolveRequestUsageSource would label them 'api'.
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
      feature: charge.feature ?? 'completion_api',
      provider: charge.provider,
      model: charge.model,
      inputTokens: charge.inputTokens,
      outputTokens: charge.outputTokens,
      cachedInputTokens: charge.cacheReadInputTokens ?? 0,
      cacheWriteTokens: charge.cacheCreationInputTokens ?? 0,
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

type CompletionMeterOptions = { sessionId?: string; organizationId?: string | null; systemModel?: boolean };

/**
 * A CompletionMeter (b4m-core/services/src/billing/completionMeter.ts) for platform-key work with no
 * HTTP request (queue workers, crons, mission wakes): admits the model for `user`, reserves the
 * ceiling against the billing owner (`opts.organizationId` when given, else the user's org seat when
 * present, else the user), and settles through settleCompletion. Throws a 422 insufficient_credits
 * when the owner cannot cover the hold.
 */
export function createCompletionMeter(
  user: IUserDocument,
  logger: Logger,
  featureLabel: string,
  opts: CompletionMeterOptions = {}
): CompletionMeter {
  return createRequestCompletionMeter({ user, logger, headers: {} }, featureLabel, opts);
}

/**
 * createCompletionMeter for a route: bills like reserveCompletionCredits (an org-billed API key
 * bills its org, and the ledger keeps the key's source). Wrap the route's backend with
 * meterCompletionBackend so every call is reserved, settled or refunded.
 */
export function createRequestCompletionMeter(
  req: MeteredRequest,
  featureLabel: string,
  opts: CompletionMeterOptions = {}
): CompletionMeter {
  return async (modelInfo, messages, maxTokens, models, turns = 1, tools = []) => {
    await (await createModelAdmission(req.user!, models ?? [modelInfo], opts.systemModel)).assert(modelInfo.id);
    const ceilingUsd = completionCeilingUsd(modelInfo, messages, maxTokens, false, tools);
    const reservation = await reserveCompletionCredits(req, ceilingUsd * turns, featureLabel, {
      organizationId: opts.organizationId,
    });
    return {
      refund: () => reservation.refund(),
      settle: usage =>
        settleCompletion(reservation, req, {
          model: modelInfo.id,
          provider: modelInfo.backend,
          // No reported usage means the adapter could not count it; charge one turn's ceiling rather than
          // nothing (not the whole multi-turn hold, which assumes every tool round-trip ran).
          usd: hasReportedUsage(usage) ? completionUsd(modelInfo, usage) : ceilingUsd,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
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
  await assertCanAfford(user, user.organizationId ? String(user.organizationId) : undefined);
}

/**
 * assertOwnerCanAfford for work a route runs inline through createRequestCompletionMeter: gates the owner
 * the request bills (resolveRequestBillingOrgId), so an API key's billing owner is checked, not the
 * key holder's org seat.
 */
export async function assertRequestCanAfford(req: MeteredRequest): Promise<void> {
  await assertCanAfford(req.user!, resolveRequestBillingOrgId(req), Boolean(req.apiKeyInfo));
}

async function assertCanAfford(
  user: IUserDocument,
  organizationId: string | undefined,
  isApiKeyCaller = false
): Promise<void> {
  if (!(await isCreditsEnforced())) return;
  const org = organizationId ? await organizationRepository.findById(organizationId) : null;
  // Same refusal reserveRequestCredits' assertBillable raises at hold time; checked here so a departed
  // key holder gets the 400 before the caller claims any work.
  assertApiKeyOrgMembership({ billingOrg: org, billingUser: user, isApiKeyCaller });
  if (org && creditService.isMemberAtOrOverCap(org, user.id)) {
    throw insufficientCreditsError(creditService.MEMBER_CREDIT_CAP_MESSAGE);
  }
  assertOwnerHasCredits(org ?? user);
}
