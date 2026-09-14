import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';

/**
 * DeepSeek context caching. Automatic, like Moonshot's and xAI's: no parameter,
 * no header, no explicit cache-creation call. The adapter exists only to read
 * the counters back out.
 * @see https://api-docs.deepseek.com/guides/kv_cache
 */
export class DeepSeekCachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, _strategy: ICacheStrategy): Record<string, unknown> {
    return apiParams;
  }

  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined {
    const usage = response.usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    const totalInputTokens = (usage.prompt_tokens as number) || 0;
    const cachedTokens = cachedPromptTokens(usage);

    const cacheHitRate = totalInputTokens > 0 ? (cachedTokens / totalInputTokens) * 100 : 0;

    // A cache hit costs ~2% of the miss rate on both ids ($0.006 against $0.30 on
    // flash, $0.044 against $1.32 on v4-pro), so the saving on the cached portion
    // is ~98%.
    const costSavingsPercent = cacheHitRate * 0.98;
    const estimatedLatencyReduction = cacheHitRate * 0.7;

    return {
      provider: ModelBackend.DeepSeek,
      model,
      totalInputTokens,
      cacheReadTokens: cachedTokens,
      // DeepSeek does not bill or report cache writes separately.
      cacheWriteTokens: 0,
      // Clamp like the billing path (splitCacheInclusiveInput): a feed reporting
      // more cached than total tokens must not surface a negative uncached count.
      uncachedTokens: Math.max(0, totalInputTokens - cachedTokens),
      cacheHitRate,
      costSavingsPercent,
      estimatedLatencyReduction,
      providerMetadata: {
        automatic: true,
      },
    };
  }
}

/**
 * DeepSeek reports the cached portion three redundant ways. Its own
 * `prompt_cache_hit_tokens` is preferred because it is the number the invoice is
 * computed from; the OpenAI-shaped spellings are the fallback for a proxy that
 * only forwards those. Must stay in sync with `cachedTokensFromUsage`, which
 * knows the nested spellings but not DeepSeek's flat one.
 */
export function cachedPromptTokens(usage: Record<string, unknown> | undefined | null): number {
  if (!usage) return 0;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const candidates: unknown[] = [usage.prompt_cache_hit_tokens, details?.cached_tokens, usage.cached_tokens];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}
