import { ICacheStrategy, CacheUsageStats } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * Base adapter interface for provider-specific caching.
 *
 * Uses Record<string, unknown> for API params and responses because each provider has
 * different request/response shapes; adapters access provider-specific fields safely with
 * optional chaining.
 */
export interface ICachingAdapter {
  /**
   * Apply caching to API parameters before sending to provider
   * @param apiParams - Provider-specific API parameters (varies by provider)
   * @param strategy - Cache strategy configuration
   * @returns Modified API parameters with caching applied
   */
  applyCaching(apiParams: Record<string, unknown>, strategy: ICacheStrategy): Record<string, unknown>;

  /**
   * Extract cache statistics from provider response
   * @param response - Provider-specific response object (varies by provider)
   * @param model - Model identifier
   * @returns Normalized cache statistics or undefined if not available
   */
  extractCacheStats(response: Record<string, unknown>, model: string): CacheUsageStats | undefined;

  /**
   * Get recommended headers for this provider (e.g., xAI conv-id)
   */
  getHeaders?(strategy: ICacheStrategy): Record<string, string>;
}

/**
 * Helper to log cache statistics in a consistent format across all providers
 */
export function logCacheStats(logger: Logger, cacheStats: CacheUsageStats, options?: { streaming?: boolean }): void {
  if (cacheStats.cacheReadTokens > 0) {
    logger.info(`[PromptCache] ${cacheStats.provider} cache stats`, {
      provider: cacheStats.provider,
      model: cacheStats.model,
      ...(options?.streaming !== undefined && { streaming: options.streaming }),
      cacheHitRate: `${cacheStats.cacheHitRate.toFixed(2)}%`,
      costSavings: `${cacheStats.costSavingsPercent.toFixed(2)}%`,
      totalInputTokens: cacheStats.totalInputTokens,
      cacheReadTokens: cacheStats.cacheReadTokens,
      ...(cacheStats.cacheWriteTokens > 0 && { cacheWriteTokens: cacheStats.cacheWriteTokens }),
    });
  }
}
