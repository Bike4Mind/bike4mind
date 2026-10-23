import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { ANTHROPIC_BATCH_RATE, anthropicBatchCost, batchHoldModel } from './anthropicBatchPricing';

const model = {
  id: 'claude',
  pricing: {
    200_000: { input: 1e-6, output: 5e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 },
    1_000_000: { input: 2e-6, output: 10e-6, cache_read: 0.2e-6, cache_write: 2.5e-6 },
  },
} as unknown as ModelInfo;

describe('Anthropic batch pricing', () => {
  it('discounts uncached input, output, cache reads, 5m writes and 1h writes together', () => {
    const cost = anthropicBatchCost(model, {
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 20_000,
      cacheCreationInputTokens: 70_000,
      cacheWrite5mInputTokens: 30_000,
      cacheWrite1hInputTokens: 40_000,
    });
    // Standard: .01 + .005 + .002 + .0375 + .08; batch gets half of every bucket.
    expect(cost).toBeCloseTo(0.06725, 12);
  });

  it('selects the context tier from all input buckets, including one-hour cache writes', () => {
    expect(anthropicBatchCost(model, {
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 50_001,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 50_001,
    })).toBeCloseTo((0.2 + 0.01 + 0.01 + 0.200004) / 2, 12);
  });

  it('keeps aggregate-only legacy cache writes at the five-minute rate', () => {
    expect(anthropicBatchCost(model, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
    })).toBeCloseTo(0.0625, 12);
  });

  it('derives five-minute writes when only the aggregate and one-hour split are reported', () => {
    expect(anthropicBatchCost(model, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheWrite1hInputTokens: 40_000,
    })).toBeCloseTo((0.075 + 0.08) / 2, 12);
  });

  it('retains a higher configured five-minute rate when a request mixes cache TTLs', () => {
    const configured = { ...model, pricing: { 200_000: { input: 1e-6, output: 5e-6, cache_write: 3e-6 } } };
    expect(batchHoldModel(configured, true).pricing[200_000].cache_write).toBe(3e-6);
  });

  it('holds one-hour cache writes at twice each tier input rate without changing the catalog', () => {
    const held = batchHoldModel(model, true);
    expect(held.pricing[200_000].cache_write).toBe(2e-6);
    expect(held.pricing[1_000_000].cache_write).toBe(4e-6);
    expect(model.pricing[200_000].cache_write).toBe(1.25e-6);
    expect(batchHoldModel(model, false)).toBe(model);
    expect(ANTHROPIC_BATCH_RATE).toBe(0.5);
  });
});
