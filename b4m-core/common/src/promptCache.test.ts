import { describe, expect, it } from 'vitest';
import { ModelBackend, getTextModelCost, getTurnsCost, type ModelInfo } from './models';
import {
  oneHourWritesOf,
  resolvePromptCacheTtl,
  supportsOneHourPromptCache,
  withRequestTtlWrites,
} from './promptCache';
import { buildUsagePriceStamp } from './usagePriceStamp';

const claude = (id: string, backend = ModelBackend.Anthropic) => ({ id, backend }) as Pick<ModelInfo, 'id' | 'backend'>;

describe('supportsOneHourPromptCache', () => {
  it.each([
    ['claude-opus-5-5', true],
    ['claude-sonnet-5', true],
    ['claude-opus-4-6', true],
    ['claude-sonnet-4-6', true],
    ['claude-haiku-4-5', true],
    ['claude-sonnet-4-5', false],
    ['claude-opus-4-1', false],
    ['claude-3-7-sonnet-20250219', false],
  ])('%s on the direct API: %s', (id, expected) => {
    expect(supportsOneHourPromptCache(claude(id))).toBe(expected);
  });

  it('accepts Claude on Bedrock and nothing else', () => {
    expect(supportsOneHourPromptCache(claude('us.anthropic.claude-opus-5-5-v1:0', ModelBackend.Bedrock))).toBe(true);
    expect(supportsOneHourPromptCache({ id: 'gpt-5', backend: ModelBackend.OpenAI } as never)).toBe(false);
    expect(supportsOneHourPromptCache(undefined)).toBe(false);
  });
});

describe('resolvePromptCacheTtl', () => {
  const opus = claude('claude-opus-5-5');

  it('prefers the chat, then the user default, then 5 minutes', () => {
    expect(resolvePromptCacheTtl({ model: opus, chatTtl: '1h', userDefaultTtl: '5m' })).toBe('1h');
    expect(resolvePromptCacheTtl({ model: opus, chatTtl: undefined, userDefaultTtl: '1h' })).toBe('1h');
    expect(resolvePromptCacheTtl({ model: opus })).toBe('5m');
    expect(resolvePromptCacheTtl({ model: opus, chatTtl: 'forever' })).toBe('5m');
  });

  it('stays at 5 minutes on a model without the 1-hour TTL', () => {
    expect(resolvePromptCacheTtl({ model: claude('claude-sonnet-4-5'), chatTtl: '1h', userDefaultTtl: '1h' })).toBe(
      '5m'
    );
  });
});

describe('1-hour write accounting', () => {
  it('stamps unsplit writes with the request TTL and keeps a reported split', () => {
    const turns = [
      { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 1000 },
      { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 400, cacheWrite1hInputTokens: 0 },
    ];
    expect(withRequestTtlWrites(turns, '5m')).toBe(turns);
    expect(withRequestTtlWrites(turns, '1h').map(t => t.cacheWrite1hInputTokens)).toEqual([1000, 0]);
  });

  it('splits an aggregate by the report, else the TTL, never above the writes', () => {
    expect(oneHourWritesOf(1000, undefined, '1h')).toBe(1000);
    expect(oneHourWritesOf(1000, undefined, '5m')).toBe(0);
    expect(oneHourWritesOf(1000, 300, '1h')).toBe(300);
    expect(oneHourWritesOf(1000, 5000, '5m')).toBe(1000);
  });
});

describe('1-hour cache write pricing', () => {
  // Opus 5.5 rates: $4/M input, $20/M output; 5m write $5/M, 1h write $8/M, read $0.40/M.
  const opus: ModelInfo = {
    id: 'claude-opus-5-5' as ModelInfo['id'],
    type: 'text',
    name: 'Opus',
    backend: ModelBackend.Anthropic,
    contextWindow: 1_000_000,
    max_tokens: 64_000,
    pricing: { 1_000_000: { input: 4 / 1_000_000, output: 20 / 1_000_000 } },
    supportsImageVariation: false,
  };

  it('bills 1-hour writes at 2x input and the rest at 1.25x', () => {
    const fiveMinute = getTextModelCost(opus, 0, 0, 0, 100_000);
    const oneHour = getTextModelCost(opus, 0, 0, 0, 100_000, 100_000, 100_000);
    expect(fiveMinute).toBeCloseTo(0.5, 10);
    expect(oneHour).toBeCloseTo(0.8, 10);
    expect(getTextModelCost(opus, 0, 0, 0, 100_000, 100_000, 40_000)).toBeCloseTo(0.6 * 0.5 + 0.4 * 0.8, 10);
  });

  it('prices turns by their own 1-hour counts', () => {
    const cost = getTurnsCost(opus, [
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 100_000, cacheWrite1hInputTokens: 100_000 },
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 100_000 },
    ]);
    expect(cost).toBeCloseTo(0.8 + 0.5, 10);
  });

  it('stamps the 1-hour count and rate so the row recomputes', () => {
    const stamp = buildUsagePriceStamp(opus, { tierBasisTokens: 100_000, cacheWrite1hTokens: 100_000 });
    expect(stamp.cacheWrite1hTokens).toBe(100_000);
    expect(stamp.rates?.cacheWrite1h).toBeCloseTo(8 / 1_000_000, 15);
    expect(buildUsagePriceStamp(opus, { tierBasisTokens: 100_000 }).rates?.cacheWrite1h).toBeUndefined();
  });
});
