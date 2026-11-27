import {
  PROMPT_CACHE_TTLS,
  oneHourCacheWriteRate,
  resolveAppliedRates,
  usdToCreditsExpected,
  type ModelInfo,
  type PromptCacheTtl,
} from '@bike4mind/common';
import { modelSwitchCacheCredits, roundNoticeCredits } from './modelSwitchCost';

/** Tokens a new chat's price is quoted per, before it has a prompt to price. */
export const PER_TOKENS_BASIS = 100_000;

export interface PromptCacheTtlPrices {
  /** Credits to write the cache once at each TTL. */
  credits: Record<PromptCacheTtl, number>;
  /** 'chat': this conversation's last prompt; 'per100k': per PER_TOKENS_BASIS tokens. */
  basis: 'chat' | 'per100k';
}

/**
 * What one cache write costs at each TTL on `model`: this conversation's prompt when there is one,
 * else per 100K tokens. Reads cost the same at either TTL, so the write is the whole difference.
 * Null when the model is free or unpriced.
 */
export function promptCacheTtlPrices(
  model: ModelInfo | undefined,
  previousInputTokens: number | undefined,
  previousInputModelId: string | undefined
): PromptCacheTtlPrices | null {
  if (!model || model.freeToRun || !model.pricing) return null;
  if (previousInputTokens) {
    const entries = PROMPT_CACHE_TTLS.map(
      ttl => [ttl, modelSwitchCacheCredits(model, previousInputTokens, previousInputModelId, ttl)] as const
    );
    if (entries.some(([, credits]) => credits === null)) return null;
    return {
      credits: Object.fromEntries(entries.map(([ttl, credits]) => [ttl, roundCredits(credits!)])) as Record<
        PromptCacheTtl,
        number
      >,
      basis: 'chat',
    };
  }
  const rates = resolveAppliedRates(model, PER_TOKENS_BASIS);
  if (!rates) return null;
  return {
    credits: {
      '5m': roundCredits(usdToCreditsExpected(rates.cacheWrite * PER_TOKENS_BASIS)),
      '1h': roundCredits(usdToCreditsExpected(oneHourCacheWriteRate(rates) * PER_TOKENS_BASIS)),
    },
    basis: 'per100k',
  };
}

// Small figures keep their precision; the notice rounding only starts past 100.
const roundCredits = (credits: number): number => (credits < 100 ? Math.round(credits) : roundNoticeCredits(credits));
