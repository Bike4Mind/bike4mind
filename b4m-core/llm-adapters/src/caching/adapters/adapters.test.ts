import { describe, it, expect } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import { AnthropicCachingAdapter } from './anthropic';
import { getCachingAdapter, NoOpCachingAdapter } from './index';

describe('AnthropicCachingAdapter', () => {
  const adapter = new AnthropicCachingAdapter();
  const model = 'claude-4-sonnet';

  describe('extractCacheStats', () => {
    it('returns undefined when response has no usage', () => {
      expect(adapter.extractCacheStats({}, model)).toBeUndefined();
    });

    it('returns stats with all zeros when usage has no cache fields', () => {
      const response = {
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
        },
      };
      const stats = adapter.extractCacheStats(response, model);
      expect(stats).toBeDefined();
      expect(stats!.cacheReadTokens).toBe(0);
      expect(stats!.cacheWriteTokens).toBe(0);
      expect(stats!.uncachedTokens).toBe(1000);
      expect(stats!.totalInputTokens).toBe(1000);
      expect(stats!.cacheHitRate).toBe(0);
      expect(stats!.costSavingsPercent).toBe(0);
    });

    it('calculates correct stats for cache read only', () => {
      const response = {
        usage: {
          input_tokens: 200,
          cache_read_input_tokens: 180000,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.cacheReadTokens).toBe(180000);
      expect(stats.cacheWriteTokens).toBe(0);
      expect(stats.uncachedTokens).toBe(200);
      expect(stats.totalInputTokens).toBe(180200);
      expect(stats.providerMetadata?.hadCacheWrite).toBe(false);

      // Hit rate = 180000 / 180200 * 100 ≈ 99.89%
      expect(stats.cacheHitRate).toBeCloseTo(99.889, 2);
      // Cost savings = hitRate * 0.9
      expect(stats.costSavingsPercent).toBeCloseTo(89.9, 0);
      // Latency reduction = hitRate * 0.85
      expect(stats.estimatedLatencyReduction).toBeCloseTo(84.9, 0);
    });

    it('calculates correct stats for cache write only (first request)', () => {
      const response = {
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 7000,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.cacheReadTokens).toBe(0);
      expect(stats.cacheWriteTokens).toBe(7000);
      expect(stats.uncachedTokens).toBe(500);
      expect(stats.totalInputTokens).toBe(7500);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.costSavingsPercent).toBe(0);
      expect(stats.providerMetadata?.hadCacheWrite).toBe(true);
    });

    it('calculates correct stats for mixed read and write', () => {
      const response = {
        usage: {
          input_tokens: 300,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 2000,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.cacheReadTokens).toBe(10000);
      expect(stats.cacheWriteTokens).toBe(2000);
      expect(stats.uncachedTokens).toBe(300);
      expect(stats.totalInputTokens).toBe(12300);
      expect(stats.providerMetadata?.hadCacheWrite).toBe(true);

      // Hit rate = 10000 / 12300 * 100 ≈ 81.30%
      const expectedHitRate = (10000 / 12300) * 100;
      expect(stats.cacheHitRate).toBeCloseTo(expectedHitRate, 2);
      expect(stats.costSavingsPercent).toBeCloseTo(expectedHitRate * 0.9, 2);
      expect(stats.estimatedLatencyReduction).toBeCloseTo(expectedHitRate * 0.85, 2);
    });

    it('returns zero hit rate when all tokens are zero', () => {
      const response = {
        usage: {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      const stats = adapter.extractCacheStats(response, model)!;

      expect(stats.totalInputTokens).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.costSavingsPercent).toBe(0);
    });

    it('sets provider to Anthropic and passes model through', () => {
      const response = { usage: { input_tokens: 100 } };
      const stats = adapter.extractCacheStats(response, 'claude-4.5-sonnet')!;

      expect(stats.provider).toBe(ModelBackend.Anthropic);
      expect(stats.model).toBe('claude-4.5-sonnet');
    });
  });
});

describe('getCachingAdapter', () => {
  it('returns AnthropicCachingAdapter for Anthropic backend', () => {
    const adapter = getCachingAdapter(ModelBackend.Anthropic);
    expect(adapter).toBeInstanceOf(AnthropicCachingAdapter);
  });

  it('returns AnthropicCachingAdapter for Bedrock backend (uses same format)', () => {
    const adapter = getCachingAdapter(ModelBackend.Bedrock);
    expect(adapter).toBeInstanceOf(AnthropicCachingAdapter);
  });

  it('returns NoOpCachingAdapter for Ollama backend', () => {
    const adapter = getCachingAdapter(ModelBackend.Ollama);
    expect(adapter).toBeInstanceOf(NoOpCachingAdapter);
  });

  it('NoOpCachingAdapter.extractCacheStats always returns undefined', () => {
    const adapter = new NoOpCachingAdapter();
    expect(adapter.extractCacheStats({} as Record<string, unknown>, 'any-model')).toBeUndefined();
  });

  it('NoOpCachingAdapter.applyCaching returns params unchanged', () => {
    const adapter = new NoOpCachingAdapter();
    const params = { foo: 'bar' };
    expect(adapter.applyCaching(params, {} as never)).toBe(params);
  });
});
