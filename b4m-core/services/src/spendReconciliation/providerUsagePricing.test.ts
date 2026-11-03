import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { priceProviderUsage, resolveUsageModel } from './providerUsagePricing';
import type { ProviderHourlyUsage } from './providerUsageFetchers';

const model = (id: string, pricing: ModelInfo['pricing'], extra: Partial<ModelInfo> = {}) =>
  ({ id, type: 'text', backend: 'anthropic', pricing, ...extra }) as unknown as ModelInfo;

const PER_M = 1 / 1_000_000;
const TABLE = [
  model('claude-test-1', {
    200000: { input: 5 * PER_M, output: 25 * PER_M },
    1000000: { input: 10 * PER_M, output: 50 * PER_M },
  }),
  model('claude-test-2-20250101', { 200000: { input: 1 * PER_M, output: 5 * PER_M } }),
  model('claude-free', { 200000: { input: 0, output: 0 } }, { freeToRun: true }),
];

const row = (modelId: string, tokens: Partial<ProviderHourlyUsage> = {}): ProviderHourlyUsage => ({
  bucketStart: new Date('2026-10-31T10:00:00Z'),
  model: modelId,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...tokens,
});

describe('resolveUsageModel', () => {
  it('matches exactly, then with the snapshot date dropped on either side', () => {
    expect(resolveUsageModel('claude-test-1', TABLE)?.id).toBe('claude-test-1');
    expect(resolveUsageModel('claude-test-1-20261001', TABLE)?.id).toBe('claude-test-1');
    expect(resolveUsageModel('claude-test-2', TABLE)?.id).toBe('claude-test-2-20250101');
    expect(resolveUsageModel('claude-test-2-20260601', TABLE)?.id).toBe('claude-test-2-20250101');
    expect(resolveUsageModel('claude-test-3', TABLE)).toBeUndefined();
  });

  it('drops an OpenAI-style dashed date', () => {
    const openai = [model('gpt-test', { 128000: { input: PER_M, output: PER_M } })];
    expect(resolveUsageModel('gpt-test-2026-08-06', openai)?.id).toBe('gpt-test');
  });
});

describe('priceProviderUsage', () => {
  it('prices a known model on its base tier, including cache reads and writes', async () => {
    const result = await priceProviderUsage(
      'anthropic',
      [
        row('claude-test-1-20261001', {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
        }),
      ],
      TABLE
    );
    // 5 input + 25 output + 0.5 cache read (0.1x) + 6.25 cache write (1.25x), all on the 200k tier.
    expect(result.usd).toBeCloseTo(36.75, 6);
    expect(result).toMatchObject({ outputTokens: 1_000_000, unpricedOutputTokens: 0, unpricedModels: [] });
  });

  it('counts an unknown model as unpriced instead of throwing', async () => {
    const result = await priceProviderUsage(
      'anthropic',
      [row('claude-mystery', { inputTokens: 50, outputTokens: 900 })],
      TABLE
    );
    expect(result).toEqual({
      usd: 0,
      outputTokens: 900,
      unpricedOutputTokens: 900,
      unpricedModels: ['claude-mystery'],
    });
  });

  it('prices the known rows of a mixed hour and lists each unpriced model once', async () => {
    const result = await priceProviderUsage(
      'anthropic',
      [
        row('claude-test-2', { outputTokens: 1_000_000 }),
        row('claude-mystery', { outputTokens: 10 }),
        row('claude-mystery', { outputTokens: 5 }),
        row('claude-free', { outputTokens: 7 }),
        row('another-mystery', { outputTokens: 1 }),
      ],
      TABLE
    );
    expect(result.usd).toBeCloseTo(5, 6);
    expect(result).toMatchObject({
      outputTokens: 1_000_023,
      unpricedOutputTokens: 16,
      unpricedModels: ['another-mystery', 'claude-mystery'],
    });
  });

  it('treats a model with no pricing tier as unpriced', async () => {
    const result = await priceProviderUsage(
      'openai',
      [row('gpt-empty', { outputTokens: 3 })],
      [model('gpt-empty', {})]
    );
    expect(result).toMatchObject({ usd: 0, unpricedOutputTokens: 3, unpricedModels: ['gpt-empty'] });
  });

  it.each([
    ['anthropic', 'claude-opus-4-5-20251101'],
    ['anthropic', 'claude-opus-5-5-20260901'],
    ['openai', 'gpt-4o-2024-08-06'],
    ['openai', 'gpt-5.5-2026-04-23'],
  ] as const)('prices %s %s from the shipped adapter table', async (provider, modelId) => {
    const result = await priceProviderUsage(provider, [row(modelId, { inputTokens: 1000, outputTokens: 1000 })]);
    expect(result.usd).toBeGreaterThan(0);
    expect(result.unpricedModels).toEqual([]);
  });
});
