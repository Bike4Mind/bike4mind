import { CACHE_WRITE_MULTIPLIER, getTextModelCost, pricingTierForTokens, type ModelInfo } from '@bike4mind/common';
import type { BatchItemResult } from '@bike4mind/llm-adapters';

/** Anthropic applies the batch discount to output, uncached input and both cache TTLs. */
export const ANTHROPIC_BATCH_RATE = 0.5;

/** Use the highest requested cache-write rate when sizing a batch item's hold. */
export function batchHoldModel(model: ModelInfo, oneHourCache: boolean): ModelInfo {
  if (!oneHourCache) return model;
  return {
    ...model,
    pricing: Object.fromEntries(
      Object.entries(model.pricing).map(([threshold, tier]) => [threshold, {
        ...tier,
        cache_write: Math.max(tier.cache_write ?? tier.input * CACHE_WRITE_MULTIPLIER, tier.input * 2),
      }])
    ),
  };
}

/** Price disjoint token buckets on the whole prompt's context tier, then apply batch pricing. */
export function anthropicBatchCost(model: ModelInfo, usage: NonNullable<BatchItemResult['tokenUsage']>): number {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const oneHourWrites = usage.cacheWrite1hInputTokens ?? 0;
  // Older provider responses have only the aggregate: their cache writes used the default 5m TTL.
  const fiveMinuteWrites =
    usage.cacheWrite5mInputTokens ?? Math.max(0, (usage.cacheCreationInputTokens ?? 0) - oneHourWrites);
  const promptTokens = usage.inputTokens + cacheRead + fiveMinuteWrites + oneHourWrites;
  const tier = pricingTierForTokens(model, promptTokens);
  const inputRate = tier === null ? 0 : (model.pricing[tier]?.input ?? 0);
  const standardCost = getTextModelCost(
    model,
    usage.inputTokens,
    usage.outputTokens,
    cacheRead,
    fiveMinuteWrites,
    promptTokens
  );
  return (standardCost + oneHourWrites * inputRate * 2) * ANTHROPIC_BATCH_RATE;
}
