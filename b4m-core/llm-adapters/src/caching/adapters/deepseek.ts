import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';
import { cachedTokensFromUsage } from '../../cacheInclusiveUsage';

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
    const cachedTokens = cachedTokensFromUsage(usage);

    const cacheHitRate = totalInputTokens > 0 ? (cachedTokens / totalInputTokens) * 100 : 0;

    // A cache hit costs ~2% of the miss rate ($0.006 against $0.30 per 1M), so
    // the saving on the cached portion is ~98%.
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
