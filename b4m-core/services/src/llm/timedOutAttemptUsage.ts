import type { IUsageEventInput, ModelInfo, UsagePriceStamp } from '@bike4mind/common';
import type { LlmTimeoutUsage } from '@bike4mind/llm-adapters';
import { priceCompletionUsage, timedOutCompletionUsageFields } from '../billing/priceCompletionUsage';

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
  UsagePriceStamp;

/** Matches by name like isLlmTimeoutError (llm-adapters), so a second bundled copy of the class still counts. */
export function timedOutUsageOf(error: unknown): LlmTimeoutUsage | undefined {
  if (!(error instanceof Error) || error.name !== 'LlmTimeoutError') return undefined;
  return (error as Error & { usage?: LlmTimeoutUsage }).usage;
}

/** Usage a SafetyRefusalError (llm-adapters) carries for what the provider billed before the refusal. */
export function refusedUsageOf(error: unknown): LlmTimeoutUsage | undefined {
  if (!(error instanceof Error) || error.name !== 'SafetyRefusalError') return undefined;
  return (error as Error & { usage?: LlmTimeoutUsage }).usage;
}

/**
 * Usage-event fields for an attempt our own timer cut: the provider's counts priced as COGS, nothing
 * charged. inputTokens/outputTokens stay 0 because they are the local estimate that feeds token quotas.
 */
export function timedOutAttemptUsageFields(model: ModelInfo, usage: LlmTimeoutUsage): TimedOutAttemptFields {
  const { costUsd, priceStamp } = priceCompletionUsage(model, usage);
  return {
    provider: model.backend,
    model: model.id,
    ...timedOutCompletionUsageFields(usage),
    cachedInputTokens: usage.cacheReadInputTokens,
    cacheWriteTokens: usage.cacheCreationInputTokens,
    costUsd,
    creditsCharged: 0,
    ...priceStamp,
  };
}
