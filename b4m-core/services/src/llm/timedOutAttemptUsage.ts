import { buildUsagePriceStamp, getTextModelCost, type IUsageEventInput, type ModelInfo } from '@bike4mind/common';
import type { LlmTimeoutUsage } from '@bike4mind/llm-adapters';

type TimedOutAttemptFields = Pick<
  IUsageEventInput,
  | 'provider'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'providerInputTokens'
  | 'providerOutputTokens'
  | 'cachedInputTokens'
  | 'cacheWriteTokens'
  | 'settledBasis'
  | 'costUsd'
  | 'creditsCharged'
  | 'status'
> &
  ReturnType<typeof buildUsagePriceStamp>;

/** Matches by name like isLlmTimeoutError (llm-adapters), so a second bundled copy of the class still counts. */
export function timedOutUsageOf(error: unknown): LlmTimeoutUsage | undefined {
  if (!(error instanceof Error) || error.name !== 'LlmTimeoutError') return undefined;
  return (error as Error & { usage?: LlmTimeoutUsage }).usage;
}

/**
 * Usage-event fields for an attempt our own timer cut: the provider's counts priced as COGS, nothing
 * charged. inputTokens/outputTokens stay 0 because they are the local estimate that feeds token quotas.
 */
export function timedOutAttemptUsageFields(model: ModelInfo, usage: LlmTimeoutUsage): TimedOutAttemptFields {
  const { inputTokens, cacheReadInputTokens, cacheCreationInputTokens } = usage;
  const outputTokens = usage.outputTokens ?? 0;
  const promptTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    provider: model.backend,
    model: model.id,
    inputTokens: 0,
    outputTokens: 0,
    providerInputTokens: inputTokens,
    ...(outputTokens > 0 ? { providerOutputTokens: outputTokens } : {}),
    cachedInputTokens: cacheReadInputTokens,
    cacheWriteTokens: cacheCreationInputTokens,
    settledBasis: 'provider',
    costUsd: getTextModelCost(
      model,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      promptTokens
    ),
    creditsCharged: 0,
    ...buildUsagePriceStamp(model, { tierBasisTokens: promptTokens }),
    status: 'timeout',
  };
}
