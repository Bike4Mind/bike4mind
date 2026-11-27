import { describe, expect, it } from 'vitest';
import { ChatModels, ModelBackend, type ModelInfo } from '@bike4mind/common';
import { priceCompletionUsage, timedOutCompletionUsageFields } from './priceCompletionUsage';

const model: ModelInfo = {
  id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK,
  name: 'Test model',
  type: 'text',
  backend: ModelBackend.Bedrock,
  contextWindow: 100_000,
  max_tokens: 4096,
  pricing: {
    100: { input: 1e-6, output: 2e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 },
    100000: { input: 3e-6, output: 5e-6, cache_read: 0.3e-6, cache_write: 3.75e-6 },
  },
  priceSource: 'catalog',
  priceRowId: 'test-rate',
};

describe('priceCompletionUsage', () => {
  it('prices the whole cache-inclusive prompt and the reported 1-hour writes without useful turns', () => {
    const priced = priceCompletionUsage(model, {
      inputTokens: 60,
      outputTokens: 10,
      cacheReadInputTokens: 35,
      cacheCreationInputTokens: 20,
      cacheWrite1hInputTokens: 5,
      turnUsage: [{ inputTokens: 0, outputTokens: 0 }],
    });
    expect(priced).toMatchObject({
      inputTokens: 60,
      outputTokens: 10,
      cachedInputTokens: 35,
      cacheWriteTokens: 20,
      priceStamp: {
        priceSource: 'catalog',
        priceRowId: 'test-rate',
        cacheWrite1hTokens: 5,
        rates: { tierKey: 100000 },
      },
    });
    expect(priced.costUsd).toBeCloseTo(326.75e-6, 12);
  });

  it('uses provider turns for disjoint totals, tiers and 1-hour writes', () => {
    const priced = priceCompletionUsage(model, {
      inputTokens: 500,
      cacheWrite1hInputTokens: 23,
      turnUsage: [
        { inputTokens: 50, outputTokens: 20, cacheReadInputTokens: 10, cacheCreationInputTokens: 10 },
        {
          inputTokens: 90,
          outputTokens: 15,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 15,
          cacheWrite1hInputTokens: 4,
        },
      ],
    });
    expect(priced).toMatchObject({
      inputTokens: 140,
      outputTokens: 35,
      cachedInputTokens: 30,
      cacheWriteTokens: 25,
      priceStamp: { cacheWrite1hTokens: 4, turnUsage: [{ tierKey: 100 }, { tierKey: 100000 }] },
    });
    expect(priced.costUsd).toBeCloseTo(519.75e-6, 12);
  });

  it('separates timeout provider counts from quota columns and excludes absent provider output', () => {
    const priced = priceCompletionUsage(model, { cacheReadInputTokens: 8 });
    const timedOut = timedOutCompletionUsageFields(priced);
    expect(priced).toMatchObject({ cachedInputTokens: 8, inputTokens: 0, outputTokens: 0 });
    expect(timedOut).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      providerInputTokens: 0,
      settledBasis: 'provider',
      status: 'timeout',
    });
    expect(timedOutCompletionUsageFields({ inputTokens: 9, outputTokens: 3 })).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      providerInputTokens: 9,
      providerOutputTokens: 3,
    });
  });
});
