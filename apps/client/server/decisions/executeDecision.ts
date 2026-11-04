/**
 * The accounting-neutral core of a decision call: parse, validate against the model's limits,
 * resolve a key, reserve, call the provider (one same-model retry), normalize and settle.
 *
 * Who pays and whose key is used is the `DecisionAccounting` policy's job. `runDecision` is the
 * user policy (the caller's keys and credits); `server/security/abuseAssessment` is the internal
 * policy (platform keys only, a platform budget, never the assessed user's credits). Keeping one
 * core means both get the same validation, deadlines, retry and answer normalization.
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
  validateDecisionRequest,
  type DecisionAnswer,
  type DecisionInput,
  type DecisionModelCapabilities,
  type DecisionModelId,
  type DecisionProviderId,
  type DecisionResponse,
  type DecisionsRequest,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  DECISION_DEADLINE_MS,
  DecisionOverloadedError,
  DecisionProviderError,
  decideWithRetry,
  type DecideWithRetryResult,
  type ResolvedDecisionInput,
} from '@bike4mind/utils/decisionProviders';
import { DecisionRequestError } from '@server/decisions/decisionErrors';
import { getDecisionProviderRegistry } from '@bike4mind/server-utils/decisions/providers';

export type SettledDecisionUsage = {
  decisionId: string;
  provider: DecisionProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** An open hold on the worst-case cost. Exactly one of the three methods closes it. */
export type DecisionSettlement = {
  /** Nothing reached the provider (input resolution failed). */
  refund(): Promise<void>;
  /** The provider was called and failed or answered malformed. */
  fail(attempt: { model: DecisionModelId; provider: DecisionProviderId }): Promise<void>;
  /** Charges the actual cost; resolves to the credits charged (0 when the platform funds it). */
  settle(usage: SettledDecisionUsage): Promise<number>;
};

/** Whose key a call uses and who pays for it. */
export type DecisionAccounting = {
  /** A usable key for the provider, or null when this policy holds none. */
  resolveProviderKey(provider: DecisionProviderId): Promise<string | null>;
  /** Holds the worst-case cost before any provider work; throws to refuse the call. */
  reserve(hold: { decisionId: string; maxCostUsd: number }): Promise<DecisionSettlement>;
};

export type ExecuteDecisionParams = {
  model: string;
  body: Omit<DecisionsRequest, 'model'>;
  logger: Logger;
  accounting: DecisionAccounting;
  /** Turns caller input into provider input; file images need the caller's ACL, JSON does not. */
  resolveInput(input: DecisionInput, caps: DecisionModelCapabilities): Promise<ResolvedDecisionInput>;
  safetyIdentifier?: string;
};

export type ExecutedDecision = {
  response: DecisionResponse;
  costUsd: number;
  creditsCharged: number;
  retries: number;
};

const countByType = (answers: readonly DecisionAnswer[]) =>
  answers.reduce<Record<string, number>>(
    (counts, answer) => ({ ...counts, [answer.type]: (counts[answer.type] ?? 0) + 1 }),
    {}
  );

// What failed, without the message: it can carry vendor text and caller-supplied choice values.
export const describeDecisionFailure = (error: unknown) => {
  const providerError = error instanceof DecisionOverloadedError ? error.providerError : error;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    providerErrorKind: providerError instanceof DecisionProviderError ? providerError.kind : undefined,
    providerStatus: providerError instanceof DecisionProviderError ? providerError.details.status : undefined,
  };
};

/**
 * Answers one decision request. Throws `DecisionRequestError` for a caller-fixable refusal and the
 * provider error classes for a vendor failure; everything else is unexpected and surfaces as it is.
 */
export async function executeDecision({
  model,
  body,
  logger,
  accounting,
  resolveInput,
  safetyIdentifier,
}: ExecuteDecisionParams): Promise<ExecutedDecision> {
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

  const apiKey = await accounting.resolveProviderKey(caps.provider);
  if (!apiKey) {
    throw new DecisionRequestError(
      503,
      'provider_not_configured',
      undefined,
      `No ${caps.provider} credential is configured for decision model ${model}.`
    );
  }

  const decisionId = `dec_${randomUUID().replace(/-/g, '')}`;
  const startedAt = Date.now();
  // The hold comes before input resolution, so a caller who cannot pay cannot make us download and
  // decode files. The worst-case cost does not depend on the images.
  const settlement = await accounting.reserve({ decisionId, maxCostUsd: maxDecisionCostUsd(caps) });

  let input: ResolvedDecisionInput;
  try {
    input = await resolveInput(request.input, caps);
  } catch (error) {
    await settlement.refund();
    throw error;
  }

  let outcome: DecideWithRetryResult;
  let answers: DecisionAnswer[];
  try {
    outcome = await decideWithRetry({
      provider,
      request: { model, input, questions: validation.request.questions, safetyIdentifier },
      apiKey,
      logger,
      deadlineMs: decisionRequestHasImages(request) ? DECISION_DEADLINE_MS.images : DECISION_DEADLINE_MS.text,
    });
    answers = normalizeDecisionAnswers(validation.request.questions, outcome.decision.answers);
  } catch (error) {
    await settlement.fail({ model, provider: caps.provider });
    logger.warn('Decision call failed', {
      decisionId,
      model,
      provider: caps.provider,
      ...describeDecisionFailure(error),
    });
    throw error;
  }

  const { decision, retries } = outcome;
  const costUsd = decisionCostUsd(caps, decision.usage);
  const creditsCharged = await settlement.settle({
    decisionId,
    provider: caps.provider,
    model: decision.model,
    ...decision.usage,
    costUsd,
  });
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
    response: {
      id: decisionId,
      object: 'decision',
      model: decision.model,
      answers,
      usage: {
        input_tokens: decision.usage.inputTokens,
        output_tokens: decision.usage.outputTokens,
        total_tokens: decision.usage.inputTokens + decision.usage.outputTokens,
      },
    },
    costUsd,
    creditsCharged,
    retries,
  };
}
