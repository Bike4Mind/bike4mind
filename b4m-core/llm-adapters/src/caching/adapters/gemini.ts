import { ICachingAdapter } from './base';
import { ICacheStrategy, CacheUsageStats, ModelBackend } from '@bike4mind/common';

/**
 * Gemini-specific caching adapter
 * Gemini 2.5+ supports IMPLICIT (automatic) caching by default
 * Explicit caching via Vertex AI API is optional (not implemented yet)
 */
export class GeminiCachingAdapter implements ICachingAdapter {
  applyCaching(apiParams: Record<string, unknown>, strategy: ICacheStrategy): Record<string, unknown> {
    // Gemini 2.5+ has implicit caching enabled by default
    // No modifications needed unless using explicit caching API
    // TODO: Add explicit caching support via Vertex AI if needed
    return apiParams;
  }

  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined {
    const usage = response.usageMetadata as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    // Gemini provides cachedContentTokenCount in response
    const totalInputTokens = (usage.promptTokenCount as number) || 0;
    const cachedTokens = (usage.cachedContentTokenCount as number) || 0;

    const cacheHitRate = totalInputTokens > 0 ? (cachedTokens / totalInputTokens) * 100 : 0;

    // Gemini 2.5: 90% savings, Gemini 2.0: 75% savings
    const savingsMultiplier = model.includes('2.5') ? 0.9 : 0.75;
    const costSavingsPercent = cacheHitRate * savingsMultiplier;
    const estimatedLatencyReduction = cacheHitRate * 0.75;

    return {
      provider: ModelBackend.Gemini,
      model,
      totalInputTokens,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: 0, // Not exposed
      uncachedTokens: totalInputTokens - cachedTokens,
      cacheHitRate,
      costSavingsPercent,
      estimatedLatencyReduction,
      providerMetadata: {
        implicit: true,
      },
    };
  }
}
