import { createHash } from 'crypto';
import {
  BadRequestError,
  HTTPError,
  ModelBackend,
  resolveAppliedRates,
  type ModelInfo,
  type CompletionEvaluationLimits,
  type CompletionEvaluationReceipt,
} from '@bike4mind/common';
import { adminSettingsRepository, completionRunRepository } from '@bike4mind/database';
import type { ICompletionOptions } from '@bike4mind/llm-adapters';

async function allowedIds(settingName: 'evaluationUserIds' | 'evaluationModelIds'): Promise<string[]> {
  const value = (await adminSettingsRepository.getSettingsValue(settingName)) ?? '';
  return value
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

export async function assertEvaluationAuthorized(userId: string): Promise<void> {
  if (!(await allowedIds('evaluationUserIds')).includes(userId))
    throw new HTTPError(403, 'Evaluation execution is not enabled for this account.', {
      errorCode: 'evaluation_not_enabled',
    });
}

export function initialEvaluation(limits: CompletionEvaluationLimits) {
  return {
    version: 1 as const,
    limits,
    revision: 0,
    committedProviderUsd: 0,
    committedTokens: 0,
    committedRequests: 0,
    receipts: [],
  };
}

export function evaluationTransport(runId: string, requestId: string, onReady?: () => void) {
  requestId = requestId.toLowerCase();
  let admitted = false;
  let receipt: CompletionEvaluationReceipt;
  let tiers: CompletionEvaluationReceipt['rates'];
  const transport: NonNullable<NonNullable<ICompletionOptions['_internal']>['evaluation']> = {
    async admit(modelInfo: ModelInfo, wireModel: string, outputLimit: number) {
      if (admitted) throw new BadRequestError('An evaluation attempt cannot dispatch twice.');
      if (!(await allowedIds('evaluationModelIds')).includes(wireModel))
        throw new BadRequestError('Evaluation model is not enabled in the evaluationModelIds admin setting.');
      if (
        ![ModelBackend.OpenAI, ModelBackend.Anthropic].includes(modelInfo.backend) ||
        modelInfo.id !== wireModel ||
        !Number.isSafeInteger(outputLimit) ||
        outputLimit <= 0 ||
        !Number.isSafeInteger(modelInfo.contextWindow) ||
        modelInfo.contextWindow <= 0
      ) {
        throw new BadRequestError('Unsupported evaluation model or output bound.');
      }
      tiers = Object.keys(modelInfo.pricing)
        .map(Number)
        .map(tier => {
          const rates = resolveAppliedRates(modelInfo, tier);
          const raw = modelInfo.pricing[tier];
          if (
            !rates ||
            !raw ||
            raw.cache_read === undefined ||
            [rates.input, rates.output, rates.cacheRead].some(rate => !Number.isFinite(rate) || rate < 0) ||
            rates.input <= 0 ||
            rates.output <= 0
          )
            throw new BadRequestError('Evaluation requires explicit provider pricing.');
          return {
            tier,
            input: rates.input,
            output: rates.output,
            cacheRead: rates.cacheRead,
            ...(modelInfo.backend === ModelBackend.Anthropic
              ? { cacheWrite5m: raw.cache_write ?? rates.input * 1.25, cacheWrite1h: rates.input * 2 }
              : {}),
          };
        });
      if (!tiers.length) throw new BadRequestError('Evaluation model is unpriced.');
      const inputBound = modelInfo.contextWindow;
      if (tiers.some(t => [t.cacheWrite5m ?? 0, t.cacheWrite1h ?? 0].some(rate => !Number.isFinite(rate) || rate < 0)))
        throw new BadRequestError('Invalid evaluation cache write pricing.');
      const maxProviderUsd =
        Math.ceil(
          (inputBound *
            Math.max(...tiers.map(t => Math.max(t.input, t.cacheRead, t.cacheWrite5m ?? 0, t.cacheWrite1h ?? 0))) +
            outputLimit * Math.max(...tiers.map(t => t.output))) *
            1e9
        ) / 1e9;
      receipt = {
        version: 1,
        requestId,
        attemptId: requestId,
        status: 'pending',
        revision: 1,
        modelId: wireModel,
        backend: modelInfo.backend,
        pricingRevision: createHash('sha256').update(JSON.stringify(tiers)).digest('hex'),
        maxProviderUsd,
        maxTokens: inputBound + outputLimit,
        maxInputTokens: inputBound,
        maxOutputTokens: outputLimit,
        rates: tiers,
      };
      await completionRunRepository.updateEvaluation(runId, state => {
        if (state.receipts.some(r => r.requestId === requestId))
          throw new HTTPError(409, 'Evaluation request already exists; recover its receipt.', {
            errorCode: 'evaluation_request_exists',
          });
        if (state.receipts.some(r => r.status === 'unknown' || r.status === 'pending'))
          throw new HTTPError(409, 'Recover the outstanding evaluation receipt before admission.', {
            errorCode: 'evaluation_receipt_outstanding',
          });
        if (
          !state.limits.modelIds.includes(wireModel) ||
          state.committedProviderUsd + maxProviderUsd > state.limits.maxProviderUsd ||
          state.committedTokens + receipt.maxTokens > state.limits.maxTokens ||
          state.committedRequests >= state.limits.maxRequests
        )
          throw new HTTPError(422, 'Evaluation budget exhausted or model not admitted.', {
            errorCode: 'evaluation_budget_exhausted',
          });
        state.receipts.push(receipt);
        state.committedProviderUsd += maxProviderUsd;
        state.committedTokens += receipt.maxTokens;
        state.committedRequests++;
        return state;
      });
      admitted = true;
      onReady?.();
    },
    async reconcile(usage) {
      if (!admitted) throw new Error('Evaluation dispatch was not admitted');
      const { inputTokens, outputTokens, cacheReadTokens, reasoningTokens } = usage;
      if (
        receipt.backend === ModelBackend.Anthropic &&
        (usage.cacheWrite5mTokens === undefined || usage.cacheWrite1hTokens === undefined)
      )
        throw new Error('Anthropic cache write usage missing');
      const cacheWrite5mTokens = usage.cacheWrite5mTokens ?? 0;
      const cacheWrite1hTokens = usage.cacheWrite1hTokens ?? 0;
      const cachedTokens = cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens;
      if (inputTokens > receipt.maxInputTokens || outputTokens > receipt.maxOutputTokens)
        throw new Error('Provider usage exceeded admitted token bounds');
      if (
        [inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, reasoningTokens ?? 0].some(
          n => !Number.isSafeInteger(n) || n < 0
        ) ||
        cachedTokens > inputTokens ||
        inputTokens + outputTokens > receipt.maxTokens ||
        (reasoningTokens ?? 0) > outputTokens
      )
        throw new Error('Invalid authoritative evaluation usage');
      const sorted = [...tiers].sort((a, b) => a.tier - b.tier);
      const tier = sorted.find(t => inputTokens <= t.tier) ?? sorted.at(-1);
      if (!tier) throw new Error('Unknown provider price tier');
      if (
        (cacheWrite5mTokens > 0 && tier.cacheWrite5m === undefined) ||
        (cacheWrite1hTokens > 0 && tier.cacheWrite1h === undefined)
      )
        throw new Error('Cache write pricing missing');
      const providerUsd =
        (inputTokens - cachedTokens) * tier.input +
        cacheReadTokens * tier.cacheRead +
        cacheWrite5mTokens * (tier.cacheWrite5m ?? 0) +
        cacheWrite1hTokens * (tier.cacheWrite1h ?? 0) +
        outputTokens * tier.output;
      if (providerUsd > receipt.maxProviderUsd) throw new Error('Provider usage exceeded admitted bound');
      await completionRunRepository.updateEvaluation(runId, state => {
        const stored = state.receipts.find(r => r.requestId === requestId);
        if (!stored) throw new Error('Evaluation receipt missing');
        if (stored.status === 'complete') return state;
        state.committedProviderUsd = Math.max(0, state.committedProviderUsd - stored.maxProviderUsd + providerUsd);
        state.committedTokens -= stored.maxTokens - inputTokens - outputTokens;
        Object.assign(stored, usage, {
          providerUsd,
          tierBasisTokens: inputTokens,
          cacheWrite5mTokens,
          cacheWrite1hTokens,
          status: 'complete',
          revision: stored.revision + 1,
          provenance: 'provider-reported-usage/catalog-rates',
        });
        return state;
      });
    },
    async unknown() {
      if (!admitted) return;
      await completionRunRepository.updateEvaluation(runId, state => {
        const stored = state.receipts.find(r => r.requestId === requestId);
        if (stored?.status === 'pending') {
          stored.status = 'unknown';
          stored.revision++;
        }
        return state;
      });
    },
  };
  return {
    ...transport,
    async rejected(modelId: string) {
      if (admitted) return;
      await completionRunRepository.updateEvaluation(runId, state => {
        if (state.receipts.some(r => r.requestId === requestId) || state.receipts.length >= 10000) return state;
        state.receipts.push({
          version: 1,
          requestId,
          attemptId: requestId,
          status: 'rejected-before-dispatch',
          revision: 1,
          modelId,
          backend: 'not-dispatched',
          pricingRevision: 'not-dispatched',
          maxProviderUsd: 0,
          maxTokens: 0,
          maxInputTokens: 0,
          maxOutputTokens: 0,
          rates: [],
        });
        return state;
      });
    },
    async platform(outcome: { usdCost?: number; creditsCharged: number }) {
      await completionRunRepository.updateEvaluation(runId, state => {
        const stored = state.receipts.find(r => r.requestId === requestId);
        if (stored) {
          stored.platformUsd = outcome.usdCost;
          stored.platformCredits = outcome.creditsCharged;
          stored.revision++;
        }
        return state;
      });
    },
  };
}
