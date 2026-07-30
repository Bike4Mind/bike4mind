import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';

/**
 * Moonshot (Kimi) context caching. Automatic, like xAI's: there is no parameter,
 * no header, and no explicit cache-creation call. A prompt only becomes cacheable
 * once it exceeds 256 tokens, so short turns legitimately report a 0% hit rate.
 * @see https://platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api
 */
export class KimiCachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, _strategy: ICacheStrategy): Record<string, unknown> {
    return apiParams;
  }

  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined {
    const usage = response.usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    const totalInputTokens = (usage.prompt_tokens as number) || 0;
    // Documented as flat `cached_tokens`; the nested OpenAI spelling is accepted
    // too, since the endpoint claims OpenAI compatibility and this number drives
    // what the user is billed for a cache hit. Must stay in sync with
    // KimiBackend.cachedTokensOf.
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cachedTokens = (usage.cached_tokens as number) || (details?.cached_tokens as number) || 0;

    const cacheHitRate = totalInputTokens > 0 ? (cachedTokens / totalInputTokens) * 100 : 0;

    // Moonshot prices a cache read at ~10% of input across the family (K3:
    // $0.30 against $3.00), so a hit saves ~90% on the cached portion.
    const costSavingsPercent = cacheHitRate * 0.9;
    const estimatedLatencyReduction = cacheHitRate * 0.7;

    return {
      provider: ModelBackend.Kimi,
      model,
      totalInputTokens,
      cacheReadTokens: cachedTokens,
      // Moonshot does not bill or report cache writes separately.
      cacheWriteTokens: 0,
      // Clamp like the billing path (splitCachedInput): a feed reporting more
      // cached than total tokens must not surface a negative uncached count.
      uncachedTokens: Math.max(0, totalInputTokens - cachedTokens),
      cacheHitRate,
      costSavingsPercent,
      estimatedLatencyReduction,
      providerMetadata: {
        automatic: true,
        minimumCacheablePromptTokens: 256,
      },
    };
  }
}
