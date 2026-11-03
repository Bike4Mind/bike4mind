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
 * same billing path with no HTTP request in hand.
 */

import { randomUUID } from 'node:crypto';
import {
  DecisionsRequestSchema,
  decisionCostUsd,
  decisionRequestHasImages,
  getDecisionModelCapabilities,
  isDecisionModelId,
  maxDecisionCostUsd,
  normalizeDecisionAnswers,
  usdToCredits,
  usdToCreditsStochastic,
  validateDecisionRequest,
  type CompletionSource,
  type DecisionAnswer,
  type DecisionModelId,
  type DecisionResponse,
  type DecisionsRequest,
  type IUserDocument,
} from '@bike4mind/common';
import { adminSettingsRepository, usageEventRepository } from '@bike4mind/database';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  DECISION_DEADLINE_MS,
  DecisionOverloadedError,
  DecisionProviderError,
  decideWithRetry,
  type DecideWithRetryResult,
  type ResolvedDecisionInput,
} from '@bike4mind/utils/decisionProviders';
import { reserveRequestCredits } from '@server/billing/reserveRequestCredits';
import { DecisionRequestError } from '@server/decisions/decisionErrors';
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

const countByType = (answers: readonly DecisionAnswer[]) =>
  answers.reduce<Record<string, number>>(
    (counts, answer) => ({ ...counts, [answer.type]: (counts[answer.type] ?? 0) + 1 }),
    {}
  );

// What failed, without the message: it can carry vendor text and caller-supplied choice values.
const describeFailure = (error: unknown) => {
  const providerError = error instanceof DecisionOverloadedError ? error.providerError : error;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    providerErrorKind: providerError instanceof DecisionProviderError ? providerError.kind : undefined,
    providerStatus: providerError instanceof DecisionProviderError ? providerError.details.status : undefined,
  };
};

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
  const { userId, user, logger, source, apiKeyId } = caller;
  const model = body.model ?? (await firstCallableDecisionModel(userId, logger));

  // Re-parse even on the route path (where the contract already did): a tool caller's arguments
  // are model-authored JSON, and this is the gate that keeps a malformed question out of the
  // provider. Values are identical on the route, so its behavior is unchanged.
  const parsed = DecisionsRequestSchema.safeParse({ ...body, model });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DecisionRequestError(
      422,
      'invalid_request',
      issue?.path.join('.') || undefined,
      issue?.message ?? 'Invalid decision request'
    );
  }
  const request = parsed.data;

  const provider = isDecisionModelId(model) ? getDecisionProviderRegistry().forModel(model) : undefined;
  if (!provider || !isDecisionModelId(model)) {
    throw new DecisionRequestError(422, 'model_unavailable', 'model', `${model} is not served by this deployment.`);
  }
  const caps = getDecisionModelCapabilities(model);
  const validation = validateDecisionRequest(request, caps);
  if (!validation.ok) {
    throw new DecisionRequestError(422, validation.code, validation.param, validation.message);
  }

  const apiKey = await resolveDecisionProviderKey(userId, caps.provider, logger);
  if (!apiKey) {
    throw new DecisionRequestError(
      503,
      'provider_not_configured',
      undefined,
      `No ${caps.provider} credential is configured for decision model ${model}.`
    );
  }

  const fileRequest: FabFileAccessRequest = { user, apiKeyInfo: caller.apiKeyInfo, logger };

  // The hold comes before image resolution, so a caller who cannot pay cannot make us download and decode files.
  // The worst-case cost does not depend on the images.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['enforceCredits'], skipCache: true }
  );
  const maxCostUsd = maxDecisionCostUsd(caps);
  const reservation = await reserveRequestCredits({
    // Separate from `fileRequest`: billing reads the key's owner slice, file access its scopes.
    req: { user, apiKeyInfo: caller.apiKeyInfo, logger },
    requiredCredits: maxCostUsd > 0 ? usdToCredits(maxCostUsd) : 0,
    enforceCredits: getSettingsValue('enforceCredits', settings),
    featureLabel: 'decisions',
    billingOrganizationId: caller.billingOrganizationId,
  });

  const decisionId = `dec_${randomUUID().replace(/-/g, '')}`;
  const startedAt = Date.now();
  const recordUsage = (
    status: 'ok' | 'error',
    usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number; creditsCharged: number }
  ) =>
    usageEventRepository
      .record({
        requestId: decisionId,
        userId,
        ownerId: reservation.ownerId,
        ownerType: reservation.ownerType,
        sessionId: decisionId,
        feature: 'decision',
        provider: caps.provider,
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

  let input: ResolvedDecisionInput;
  try {
    input = await resolveDecisionInput(fileRequest, request.input, caps);
  } catch (error) {
    await reservation.refund();
    throw error;
  }

  let outcome: DecideWithRetryResult;
  let answers: DecisionAnswer[];
  try {
    outcome = await decideWithRetry({
      provider,
      request: {
        model,
        input,
        questions: request.questions,
        safetyIdentifier: request.safety_identifier ?? toProviderEndUserId(userId),
      },
      apiKey,
      logger,
      deadlineMs: decisionRequestHasImages(request) ? DECISION_DEADLINE_MS.images : DECISION_DEADLINE_MS.text,
    });
    answers = normalizeDecisionAnswers(request.questions, outcome.decision.answers);
  } catch (error) {
    await reservation.refund();
    recordUsage('error', { model, inputTokens: 0, outputTokens: 0, costUsd: 0, creditsCharged: 0 });
    logger.warn('Decision call failed', { decisionId, model, provider: caps.provider, ...describeFailure(error) });
    throw error;
  }

  const { decision, retries } = outcome;
  const costUsd = decisionCostUsd(caps, decision.usage);
  const creditsCharged = await reservation.settle(usdToCreditsStochastic(costUsd), {
    type: 'decision_usage',
    sessionId: decisionId,
    model: decision.model,
    inputTokens: decision.usage.inputTokens,
    outputTokens: decision.usage.outputTokens,
    apiKeyId,
    source,
  });
  recordUsage('ok', { model: decision.model, ...decision.usage, costUsd, creditsCharged });
  logger.info('Decision answered', {
    decisionId,
    model: decision.model,
    provider: caps.provider,
    questionsByType: countByType(answers),
    latencyMs: Date.now() - startedAt,
    retries,
    inputTokens: decision.usage.inputTokens,
    outputTokens: decision.usage.outputTokens,
    costUsd,
    creditsCharged,
  });

  return {
    id: decisionId,
    object: 'decision',
    model: decision.model,
    answers,
    usage: {
      input_tokens: decision.usage.inputTokens,
      output_tokens: decision.usage.outputTokens,
      total_tokens: decision.usage.inputTokens + decision.usage.outputTokens,
    },
  };
}
