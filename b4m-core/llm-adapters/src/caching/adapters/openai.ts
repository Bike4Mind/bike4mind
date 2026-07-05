import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';

/**
 * OpenAI-specific caching adapter
 * OpenAI caching is AUTOMATIC - no explicit markers needed
 * Just ensure static content is at the beginning of prompts
 */
export class OpenAICachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, strategy: ICacheStrategy): Record<string, unknown> {
    // OpenAI caching is automatic - return params unchanged
    // The only optimization is ensuring static content comes first,
    // which should already be the case in your message construction
    return apiParams;
  }

  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined {
    const usage = response.usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    // OpenAI provides cached token info in prompt_tokens_details
    const totalInputTokens = (usage.prompt_tokens as number) || 0;
    const promptTokenDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const cachedTokens = (promptTokenDetails?.cached_tokens as number) || 0;

    const cacheHitRate = totalInputTokens > 0 ? (cachedTokens / totalInputTokens) * 100 : 0;

    const costSavingsPercent = cacheHitRate * 0.9;
    const estimatedLatencyReduction = cacheHitRate * 0.8;

    return {
      provider: ModelBackend.OpenAI,
      model,
      totalInputTokens,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: 0, // OpenAI doesn't expose this
      uncachedTokens: totalInputTokens - cachedTokens,
      cacheHitRate,
      costSavingsPercent,
      estimatedLatencyReduction,
      providerMetadata: {
        automatic: true,
      },
    };
  }
}
