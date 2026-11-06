/**
 * The decision lifecycle, shared by `POST /api/v1/decisions` and the `decide` tool.
 *
 * Synchronous, like embeddings: the worst-case cost (the model's whole input window) is RESERVED
 * before the provider call, refunded if it fails, and settled with `usdToCreditsStochastic` on
 * success, so a ~0.1-credit call charges its exact expected cost instead of a one-credit floor.
 * The provider is retried once on the same model, never another. Inputs are never logged or
 * persisted; only counts, usage and cost are.
 *
 * Takes a caller slice rather than an Express request, so an agent loop or CLI turn reaches the
 * same billing path with no HTTP request in hand. This file is the user accounting policy over
 * `executeDecision`, which owns validation, the provider call and normalization.
 */

import {
  getDecisionModelCapabilities,
  usdToCredits,
  usdToCreditsStochastic,
  type CompletionSource,
  type DecisionModelId,
  type DecisionProviderId,
  type DecisionResponse,
  type DecisionsRequest,
  type IUserDocument,
} from '@bike4mind/common';
import { adminSettingsRepository, usageEventRepository } from '@bike4mind/database';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { DecisionRequestError } from '@server/decisions/decisionErrors';
import { executeDecision, type DecisionAccounting } from '@server/decisions/executeDecision';
import {
  getDecisionProviderRegistry,
  resolveCallableDecisionProviders,
  resolveDecisionProviderKey,
} from '@bike4mind/server-utils/decisions/providers';
import { resolveDecisionInput } from '@server/decisions/resolveDecisionInput';
import type { FabFileAccessRequest } from '@server/files/loadAccessibleFabFile';

/** Who the call is billed to and attributed to - the route, the chat path or the agent executor. */
export type DecisionCaller = {
  userId: string;
  user: IUserDocument;
  logger: Logger;
  /** Usage-event and ledger attribution (`web`, `api`, `agent`, `cli`, ...). */
  source: CompletionSource;
  /** The authenticating key, echoed onto the usage event. */
  apiKeyId?: string;
  /** The key's scope + billing slice, when one authenticated the turn. */
  apiKeyInfo?: Pick<Express.ApiKeyInfo, 'keyId' | 'scopes' | 'billingOwnerType' | 'organizationId'>;
  /** Validated active workspace for a tool turn; null explicitly selects personal credits. */
  billingOrganizationId?: string | null;
};

/** The request body, with `model` optional: a tool caller lets the deployment pick the first callable one. */
export type DecisionRunBody = Omit<DecisionsRequest, 'model'> & { model?: string };

/** The first model this deployment serves whose provider the caller holds a usable key for. */
const firstCallableDecisionModel = async (userId: string, logger: Logger): Promise<DecisionModelId> => {
  const models = getDecisionProviderRegistry().models();
  const providers = [...new Set(models.map(model => getDecisionModelCapabilities(model).provider))];
  const callable = await resolveCallableDecisionProviders(userId, providers, logger);
  const model = models.find(id => callable.has(getDecisionModelCapabilities(id).provider));
  if (!model) {
    throw new DecisionRequestError(
      503,
      'provider_not_configured',
      undefined,
      'No decision provider credential is configured for this caller.'
    );
  }
  return model;
};

/** The user policy: the caller's own effective keys, a credit hold on their balance, a usage event. */
const userDecisionAccounting = (caller: DecisionCaller): DecisionAccounting => {
  const { userId, user, logger, source, apiKeyId } = caller;
  return {
    resolveProviderKey: provider => resolveDecisionProviderKey(userId, provider, logger),
    reserve: async ({ decisionId, maxCostUsd }) => {
      const settings = await getSettingsMap(
        { adminSettings: adminSettingsRepository },
        { names: ['enforceCredits'], skipCache: true }
      );
      const reservation = await reserveRequestCredits({
        req: { user, apiKeyInfo: caller.apiKeyInfo, logger },
        requiredCredits: maxCostUsd > 0 ? usdToCredits(maxCostUsd) : 0,
        enforceCredits: getSettingsValue('enforceCredits', settings),
        featureLabel: 'decisions',
        billingOrganizationId: caller.billingOrganizationId,
      });
      const startedAt = Date.now();
      const recordUsage = (
        status: 'ok' | 'error',
        usage: {
          provider: DecisionProviderId;
          model: string;
          inputTokens: number;
          outputTokens: number;
          costUsd: number;
          creditsCharged: number;
        }
      ) =>
        usageEventRepository
          .record({
            requestId: decisionId,
            userId,
            ownerId: reservation.ownerId,
            ownerType: reservation.ownerType,
            sessionId: decisionId,
            feature: 'decision',
            provider: usage.provider,
            model: usage.model,
            source,
            apiKeyId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            settledBasis: 'provider',
            costUsd: usage.costUsd,
            creditsCharged: usage.creditsCharged,
            latencyMs: Date.now() - startedAt,
            status,
          })
          .catch(err => logger.warn('Failed to record decision usage event', { err }));

      return {
        refund: () => reservation.refund(),
        fail: async ({ model, provider }) => {
          await reservation.refund();
          void recordUsage('error', {
            provider,
            model,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            creditsCharged: 0,
          });
        },
        settle: async usage => {
          const creditsCharged = await reservation.settle(usdToCreditsStochastic(usage.costUsd), {
            type: 'decision_usage',
            sessionId: usage.decisionId,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            apiKeyId,
            source,
          });
          void recordUsage('ok', { ...usage, creditsCharged });
          return creditsCharged;
        },
      };
    },
  };
};

/**
 * Answers one decision request and returns the wire response. Throws `DecisionRequestError` for a
 * caller-fixable refusal and the provider error classes for a vendor failure; everything else is
 * unexpected and must surface as it is.
 */
export async function runDecision({
  caller,
  body,
}: {
  caller: DecisionCaller;
  body: DecisionRunBody;
}): Promise<DecisionResponse> {
  const { userId, user, logger } = caller;
  const model = body.model ?? (await firstCallableDecisionModel(userId, logger));
  const fileRequest: FabFileAccessRequest = { user, apiKeyInfo: caller.apiKeyInfo, logger };
  const { response } = await executeDecision({
    model,
    body,
    logger,
    accounting: userDecisionAccounting(caller),
    resolveInput: (input, caps) => resolveDecisionInput(fileRequest, input, caps),
    safetyIdentifier: body.safety_identifier ?? toProviderEndUserId(userId),
  });
  return response;
}
