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
    ['DeepSeek flat', { prompt_cache_hit_tokens: 1220 }],
    ['Moonshot flat', { cached_tokens: 1220 }],
    ['OpenAI chat completions', { prompt_tokens_details: { cached_tokens: 1220 } }],
    ['OpenAI responses', { input_tokens_details: { cached_tokens: 1220 } }],
  ])('reads the %s spelling', (_label, usage) => {
    expect(cachedTokensFromUsage(usage)).toBe(1220);
  });

  /** Ordered as cachedTokensFromUsage reads them, one distinct value per spelling. */
  const RANKED_SPELLINGS: ReadonlyArray<{ label: string; shape: Record<string, unknown>; tokens: number }> = [
    { label: 'prompt_cache_hit_tokens', shape: { prompt_cache_hit_tokens: 11 }, tokens: 11 },
    { label: 'cached_tokens', shape: { cached_tokens: 22 }, tokens: 22 },
    {
      label: 'prompt_tokens_details.cached_tokens',
      shape: { prompt_tokens_details: { cached_tokens: 33 } },
      tokens: 33,
    },
    { label: 'input_tokens_details.cached_tokens', shape: { input_tokens_details: { cached_tokens: 44 } }, tokens: 44 },
  ];

  it('resolves the four spellings in a fixed order when a usage carries several', () => {
    // The precedence guarantee itself, which no single-field adapter test reaches:
    // DeepSeek sends its own field ALONGSIDE the OpenAI-shaped nesting, and the two
    // need not agree. Each case supplies one rank and every rank below it, so the
    // value returned names the branch that answered and any reordering of the
    // candidate list breaks at least one expectation.
    RANKED_SPELLINGS.forEach(({ label, tokens }, rank) => {
      const usage: Record<string, unknown> = Object.assign({}, ...RANKED_SPELLINGS.slice(rank).map(e => e.shape));

      expect(cachedTokensFromUsage(usage), `${label} lost to a lower-ranked spelling`).toBe(tokens);
    });
  });

  it.each([
    ['zero', 0],
    ['a negative count', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a numeric string', '1220'],
    ['null', null],
  ])('falls through %s in a higher-precedence field rather than settling on it', (_label, useless) => {
    // Short-circuiting on the 0 a provider sends for a cold turn would bill a warm
    // turn at the full input rate whenever a lower-ranked field carries the real count.
    expect(cachedTokensFromUsage({ prompt_cache_hit_tokens: useless, cached_tokens: 1220 })).toBe(1220);
  });

  it('reads past a details object that is absent rather than empty', () => {
    expect(
      cachedTokensFromUsage({ prompt_tokens_details: undefined, input_tokens_details: { cached_tokens: 7 } })
    ).toBe(7);
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
