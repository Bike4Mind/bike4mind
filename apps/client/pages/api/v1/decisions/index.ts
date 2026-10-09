/**
 * POST /api/v1/decisions - typed questions answered with calibrated probabilities (contract: decisions.contract.ts).
 *
 * Synchronous, like embeddings: the worst-case cost (the model's whole input window) is RESERVED before the provider
 * call, refunded if it fails, and settled with `usdToCreditsStochastic` on success, so a ~0.1-credit call charges its
 * exact expected cost instead of a one-credit floor. The provider is retried once on the same model, never another.
 * Inputs are never logged or persisted; only counts, usage and cost are.
 */

import { randomUUID } from 'node:crypto';
import {
  createDecisionContract,
  decisionCostUsd,
  decisionRequestHasImages,
  getDecisionModelCapabilities,
  isDecisionModelId,
  maxDecisionCostUsd,
  normalizeDecisionAnswers,
  usdToCredits,
  usdToCreditsStochastic,
  validateDecisionRequest,
  type DecisionAnswer,
  type DecisionResponse,
} from '@bike4mind/common';
import { adminSettingsRepository, usageEventRepository } from '@bike4mind/database';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
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
import { sendDecisionError } from '@server/decisions/decisionErrors';
import { getDecisionProviderRegistry, resolveDecisionProviderKey } from '@server/decisions/providers';
import { resolveDecisionInput } from '@server/decisions/resolveDecisionInput';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';

/**
 * Per-user ceiling, in its own bucket: decision calls are cheap and bursty (routing, triage), so they must not share
 * the chat-tuned per-user budget, and a cap still stops one tenant draining the shared platform vendor key.
 */
const DECISIONS_RATE_LIMIT_PER_MINUTE = 300;

/** Inline data: URL images push bodies past baseApi's 1 MB default; 4 MB stays under Lambda's 6 MB request cap. */
const DECISIONS_MAX_BODY_BYTES = 4 * 1024 * 1024;

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

const handler = nextRouteForContract(createDecisionContract, {
  maxBodySize: DECISIONS_MAX_BODY_BYTES,
  rateLimit: rateLimit({ limit: DECISIONS_RATE_LIMIT_PER_MINUTE, windowMs: 60_000, bucket: 'POST /api/v1/decisions' }),
}).post(async (req, res) => {
  const body = req.validated;
  const { model } = body;
  const provider = isDecisionModelId(model) ? getDecisionProviderRegistry().forModel(model) : undefined;
  if (!provider || !isDecisionModelId(model)) {
    return res
      .status(422)
      .json({ error: `${model} is not served by this deployment.`, errorCode: 'model_unavailable', param: 'model' });
  }
  const caps = getDecisionModelCapabilities(model);
  const validation = validateDecisionRequest(body, caps);
  if (!validation.ok) {
    return res.status(422).json({ error: validation.message, errorCode: validation.code, param: validation.param });
  }

  const userId = req.user.id;
  const apiKey = await resolveDecisionProviderKey(userId, caps.provider, req.logger);
  if (!apiKey) {
    return res.status(503).json({
      error: `No ${caps.provider} credential is configured for decision model ${model}.`,
      errorCode: 'provider_not_configured',
    });
  }

  // The hold comes before image resolution, so a caller who cannot pay cannot make us download and decode files.
  // The worst-case cost does not depend on the images.
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const maxCostUsd = maxDecisionCostUsd(caps);
  const reservation = await reserveRequestCredits({
    req,
    requiredCredits: maxCostUsd > 0 ? usdToCredits(maxCostUsd) : 0,
    enforceCredits: getSettingsValue('enforceCredits', settings),
    featureLabel: 'decisions',
  });

  const decisionId = `dec_${randomUUID().replace(/-/g, '')}`;
  const source = resolveRequestUsageSource(req);
  const apiKeyId = req.apiKeyInfo?.keyId;
  const startedAt = Date.now();
  // A refund that throws must not replace the error the caller is owed.
  const releaseHold = async () => {
    try {
      await reservation.refund();
    } catch (err) {
      req.logger.error('Failed to refund decision credit hold', { decisionId, err });
    }
  };
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
      .catch(err => req.logger.warn('Failed to record decision usage event', { err }));

  let input: ResolvedDecisionInput;
  try {
    input = await resolveDecisionInput(req, validation.request.input, caps);
  } catch (error) {
    await releaseHold();
    if (sendDecisionError(res, error)) return;
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
        questions: validation.request.questions,
        safetyIdentifier: body.safety_identifier ?? toProviderEndUserId(userId),
      },
      apiKey,
      logger: req.logger,
      deadlineMs: decisionRequestHasImages(body) ? DECISION_DEADLINE_MS.images : DECISION_DEADLINE_MS.text,
    });
    answers = normalizeDecisionAnswers(validation.request.questions, outcome.decision.answers);
  } catch (error) {
    await releaseHold();
    recordUsage('error', { model, inputTokens: 0, outputTokens: 0, costUsd: 0, creditsCharged: 0 });
    req.logger.warn('Decision call failed', { decisionId, model, provider: caps.provider, ...describeFailure(error) });
    if (sendDecisionError(res, error)) return;
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
  req.logger.info('Decision answered', {
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

  const response: DecisionResponse = {
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
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(response);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
    // Must match DECISIONS_MAX_BODY_BYTES, which baseApi checks first.
    bodyParser: { sizeLimit: '4mb' },
  },
};
