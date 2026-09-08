import { describe, it, expect } from 'vitest';
import { cachedTokensFromUsage, splitCacheInclusiveInput } from './cacheInclusiveUsage';

describe('splitCacheInclusiveInput', () => {
  it('subtracts the cached count so the two components are disjoint', () => {
    expect(splitCacheInclusiveInput(3139, 2816)).toEqual({ inputTokens: 323, cacheReadInputTokens: 2816 });
  });

  it('omits the cache field entirely on a cold turn, so nothing implies a discount', () => {
    expect(splitCacheInclusiveInput(3139, 0)).toEqual({ inputTokens: 3139 });
  });

  it('treats a fully-cached prompt as zero uncached input rather than a negative', () => {
    expect(splitCacheInclusiveInput(1220, 1220)).toEqual({ inputTokens: 0, cacheReadInputTokens: 1220 });
  });

  it('clamps a cached count larger than the prompt instead of crediting the user', () => {
    expect(splitCacheInclusiveInput(100, 400)).toEqual({ inputTokens: 0, cacheReadInputTokens: 100 });
  });

  it('ignores a negative cached count', () => {
    expect(splitCacheInclusiveInput(500, -10)).toEqual({ inputTokens: 500 });
  });
});

describe('cachedTokensFromUsage', () => {
  it.each([
    ['Moonshot flat', { cached_tokens: 1220 }],
    ['OpenAI chat completions', { prompt_tokens_details: { cached_tokens: 1220 } }],
    ['OpenAI responses', { input_tokens_details: { cached_tokens: 1220 } }],
  ])('reads the %s spelling', (_label, usage) => {
    expect(cachedTokensFromUsage(usage)).toBe(1220);
  });

  it.each([
    ['missing usage', undefined],
    ['no cache fields', { prompt_tokens: 100 }],
    ['an explicit zero', { prompt_tokens_details: { cached_tokens: 0 } }],
    ['a non-numeric value', { prompt_tokens_details: { cached_tokens: 'lots' } }],
    ['NaN', { cached_tokens: Number.NaN }],
  ])('reports no cache read for %s', (_label, usage) => {
    expect(cachedTokensFromUsage(usage as Record<string, unknown> | undefined)).toBe(0);
  });
});
