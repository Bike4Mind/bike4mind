import { ICachingAdapter } from './base';
import { cachedTokensFromUsage } from '../../cacheInclusiveUsage';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';

/**
 * xAI Grok-specific caching adapter
 * Caching is automatic with optional conversation ID for cache affinity
 */
export class XAICachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, strategy: ICacheStrategy): Record<string, unknown> {
    // xAI caching is automatic - no param modifications needed
    return apiParams;
  }

  getHeaders(strategy: ICacheStrategy): Record<string, string> {
    const headers: Record<string, string> = {};

    // Add conversation ID for cache affinity if provided
    if (strategy.conversationId) {
      headers['x-grok-conv-id'] = strategy.conversationId;
    }

    return headers;
  }

  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined {
    const usage = response.usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    // xAI documents prompt_tokens_details.cached_tokens, the same field billing reads.
    const totalInputTokens = (usage.prompt_tokens as number) || 0;
    const cachedTokens = cachedTokensFromUsage(usage);

    const cacheHitRate = totalInputTokens > 0 ? (cachedTokens / totalInputTokens) * 100 : 0;

    // xAI: 50-75% savings
    const costSavingsPercent = cacheHitRate * 0.65; // Average 65%
    const estimatedLatencyReduction = cacheHitRate * 0.7;

    return {
      provider: ModelBackend.XAI,
      model,
      totalInputTokens,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: 0, // Not exposed
      uncachedTokens: totalInputTokens - cachedTokens,
      cacheHitRate,
      costSavingsPercent,
      estimatedLatencyReduction,
      providerMetadata: {
        automatic: true,
        conversationId: usage.x_grok_conv_id as string | undefined,
      },
    };
  }
}
