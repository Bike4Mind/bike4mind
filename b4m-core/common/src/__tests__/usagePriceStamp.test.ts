import { describe, it, expect } from 'vitest';
import {
  getTextModelCost,
  getTurnsCost,
  resolveAppliedRates,
  ModelBackend,
  type ModelInfo,
  type TurnUsage,
} from '../models';
import { buildUsagePriceStamp } from '../usagePriceStamp';
import { USAGE_EVENT_TURN_USAGE_CAP } from '../types/entities/UsageEventTypes';

// gemini-3.1-pro-preview's two tiers (geminiBackend.ts): the boundary is the 200,000 prompt tokens.
const gemini: ModelInfo = {
  id: 'gemini-3.1-pro-preview' as ModelInfo['id'],
  type: 'text',
  name: 'Gemini 3.1 Pro Preview',
  backend: ModelBackend.Gemini,
  contextWindow: 1_048_576,
  max_tokens: 65_536,
  pricing: {
    200_000: { input: 2 / 1_000_000, output: 12 / 1_000_000, cache_read: 0.2 / 1_000_000 },
    2_097_152: { input: 4 / 1_000_000, output: 18 / 1_000_000, cache_read: 0.4 / 1_000_000 },
  },
  supportsImageVariation: false,
};

const openai: ModelInfo = {
  id: 'test-model' as ModelInfo['id'],
  type: 'text',
  name: 'Test Model',
  backend: ModelBackend.OpenAI,
  contextWindow: 200_000,
  max_tokens: 4096,
  pricing: { 200_000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
  supportsImageVariation: false,
};

const LOW_TIER = { tierKey: 200_000, input: 2 / 1_000_000, output: 12 / 1_000_000 };
const HIGH_TIER = { tierKey: 2_097_152, input: 4 / 1_000_000, output: 18 / 1_000_000 };

describe('resolveAppliedRates', () => {
  it('names the lower tier at exactly 200,000 prompt tokens and the upper tier at 200,001', () => {
    expect(resolveAppliedRates(gemini, 200_000)).toMatchObject({ ...LOW_TIER, cacheRead: 0.2 / 1_000_000 });
    expect(resolveAppliedRates(gemini, 200_001)).toMatchObject({ ...HIGH_TIER, cacheRead: 0.4 / 1_000_000 });
  });

  it('resolves the cache defaults the cost function applies when a tier publishes none', () => {
    // Non-published-cache backend: 0.1x read, 1.25x write.
    const input = 10 / 1_000_000;
    expect(resolveAppliedRates(openai, 1000)).toMatchObject({ cacheRead: input * 0.1, cacheWrite: input * 1.25 });
    // Gemini publishes its own rates, so an unlisted cache_read bills at the input rate.
    const noRead: ModelInfo = { ...gemini, pricing: { 200_000: { input: 2e-6, output: 12e-6 } } };
    expect(resolveAppliedRates(noRead, 1000)).toMatchObject({ cacheRead: 2e-6, cacheWrite: 2e-6 * 1.25 });
  });

  it('is null for a model with no priced tier', () => {
    expect(resolveAppliedRates({ ...openai, pricing: {} }, 1000)).toBeNull();
  });

  it.each([
    [gemini, 1000, 500, 0, 0],
    [gemini, 200_001, 500, 3000, 0],
    [openai, 1000, 500, 4000, 2000],
  ])('reproduces getTextModelCost from the stamped rates (%#)', (model, input, output, cacheRead, cacheWrite) => {
    const tierBasis = input + cacheRead + cacheWrite;
    const rates = resolveAppliedRates(model, tierBasis)!;
    const fromRates =
      rates.input * input + rates.output * output + rates.cacheRead * cacheRead + rates.cacheWrite * cacheWrite;
    expect(getTextModelCost(model, input, output, cacheRead, cacheWrite, tierBasis)).toBe(fromRates);
  });
});

describe('buildUsagePriceStamp price source', () => {
  it('reads literal when the model never went through the catalog overlay', () => {
    const stamp = buildUsagePriceStamp(gemini, { tierBasisTokens: 1000 });
    expect(stamp.priceSource).toBe('literal');
    expect(stamp).not.toHaveProperty('priceRowId');
  });

  it('reads catalog and the row id when a ModelPrice row priced the model', () => {
    const stamp = buildUsagePriceStamp(
      { ...gemini, priceSource: 'catalog', priceRowId: 'row-1' },
      { tierBasisTokens: 1000 }
    );
    expect(stamp.priceSource).toBe('catalog');
    expect(stamp.priceRowId).toBe('row-1');
  });

  it('omits the row id for a catalog model whose row carried none', () => {
    const stamp = buildUsagePriceStamp({ ...gemini, priceSource: 'catalog' }, { tierBasisTokens: 1000 });
    expect(stamp.priceSource).toBe('catalog');
    expect(stamp).not.toHaveProperty('priceRowId');
  });

  it('never carries a row id on a literal-priced model', () => {
    const stamp = buildUsagePriceStamp(
      { ...gemini, priceSource: 'literal', priceRowId: 'stale' },
      { tierBasisTokens: 1 }
    );
    expect(stamp).not.toHaveProperty('priceRowId');
  });

  it('never throws on a model without a pricing map', () => {
    const malformed = { id: 'x', backend: ModelBackend.OpenAI } as unknown as ModelInfo;
    expect(buildUsagePriceStamp(malformed, { tierBasisTokens: 10 })).toEqual({ priceSource: 'literal' });
  });

  it('gives a model with no priced tier the source only', () => {
    const stamp = buildUsagePriceStamp({ ...openai, pricing: {} }, { tierBasisTokens: 1000 });
    expect(stamp).toEqual({ priceSource: 'literal' });
  });
});

describe('buildUsagePriceStamp rates', () => {
  it('stamps the lower tier at 200,000 and the upper tier at 200,001 on the aggregate basis', () => {
    expect(buildUsagePriceStamp(gemini, { tierBasisTokens: 200_000 }).rates).toMatchObject(LOW_TIER);
    expect(buildUsagePriceStamp(gemini, { tierBasisTokens: 200_001 }).rates).toMatchObject(HIGH_TIER);
  });

  it('tiers a single turn on its whole prompt, cache included, and writes no turnUsage', () => {
    const stamp = buildUsagePriceStamp(gemini, {
      turns: [{ inputTokens: 150_000, outputTokens: 100, cacheReadInputTokens: 50_001 }],
    });
    expect(stamp.rates).toMatchObject(HIGH_TIER);
    expect(stamp).not.toHaveProperty('turnUsage');
    expect(stamp).not.toHaveProperty('turnUsageTruncated');
  });

  it('writes no turnUsage when priced on the aggregate basis', () => {
    expect(buildUsagePriceStamp(gemini, { tierBasisTokens: 5000 })).not.toHaveProperty('turnUsage');
  });
});

describe('buildUsagePriceStamp turnUsage', () => {
  it('writes one entry per turn with its own tier, and rates from the largest turn', () => {
    const turns: TurnUsage[] = [
      { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 200 },
      { inputTokens: 200_001, outputTokens: 10, cacheCreationInputTokens: 30 },
      { inputTokens: 5000, outputTokens: 70 },
    ];
    const stamp = buildUsagePriceStamp(gemini, { turns });
    expect(stamp.rates).toMatchObject(HIGH_TIER);
    expect(stamp.turnUsage).toEqual([
      { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200, tierKey: 200_000 },
      { inputTokens: 200_001, outputTokens: 10, cacheWriteTokens: 30, tierKey: 2_097_152 },
      { inputTokens: 5000, outputTokens: 70, tierKey: 200_000 },
    ]);
    expect(stamp).not.toHaveProperty('turnUsageTruncated');
  });

  it('puts the cache-inclusive boundary turn in the upper tier, matching getTurnsCost', () => {
    const turns: TurnUsage[] = [
      { inputTokens: 100_000, outputTokens: 1, cacheReadInputTokens: 100_000 },
      { inputTokens: 100_000, outputTokens: 1, cacheReadInputTokens: 100_001 },
    ];
    const stamp = buildUsagePriceStamp(gemini, { turns });
    expect(stamp.turnUsage?.map(turn => turn.tierKey)).toEqual([200_000, 2_097_152]);
    // The stamped tiers are the ones the cost used: turn 1 at the low rates, turn 2 at the high.
    const expected = 2e-6 * 100_000 + 12e-6 * 1 + 0.2e-6 * 100_000 + (4e-6 * 100_000 + 18e-6 * 1 + 0.4e-6 * 100_001);
    expect(getTurnsCost(gemini, turns)).toBeCloseTo(expected, 12);
  });

  it('keeps all entries at the cap', () => {
    const turns = Array.from({ length: USAGE_EVENT_TURN_USAGE_CAP }, () => ({ inputTokens: 10, outputTokens: 1 }));
    const stamp = buildUsagePriceStamp(gemini, { turns });
    expect(stamp.turnUsage).toHaveLength(USAGE_EVENT_TURN_USAGE_CAP);
    expect(stamp).not.toHaveProperty('turnUsageTruncated');
  });

  it('keeps the first 99 turns and sums the rest into one tail entry past the cap', () => {
    const turns: TurnUsage[] = Array.from({ length: 101 }, (_, i) => ({
      inputTokens: 10 + i,
      outputTokens: 1,
      cacheReadInputTokens: 2,
    }));
    // Turn 101 (the tail's last) crosses the tier boundary; the tail entry takes the highest tier.
    turns[100] = { inputTokens: 200_001, outputTokens: 7, cacheCreationInputTokens: 4 };

    const stamp = buildUsagePriceStamp(gemini, { turns });
    expect(stamp.turnUsageTruncated).toBe(true);
    expect(stamp.turnUsage).toHaveLength(USAGE_EVENT_TURN_USAGE_CAP);
    expect(stamp.turnUsage![0]).toEqual({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 2, tierKey: 200_000 });
    expect(stamp.turnUsage![98]).toEqual({ inputTokens: 108, outputTokens: 1, cacheReadTokens: 2, tierKey: 200_000 });
    // Turns 100 (input 109) and 101 aggregated.
    expect(stamp.turnUsage![99]).toEqual({
      inputTokens: 109 + 200_001,
      outputTokens: 1 + 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 4,
      tierKey: 2_097_152,
    });
    expect(stamp.rates).toMatchObject(HIGH_TIER);
  });

  it('conserves total tokens across a long truncated run', () => {
    const turns: TurnUsage[] = Array.from({ length: 250 }, () => ({ inputTokens: 3, outputTokens: 2 }));
    const stamp = buildUsagePriceStamp(gemini, { turns });
    expect(stamp.turnUsage).toHaveLength(USAGE_EVENT_TURN_USAGE_CAP);
    expect(stamp.turnUsage!.reduce((sum, turn) => sum + turn.inputTokens, 0)).toBe(750);
    expect(stamp.turnUsage!.reduce((sum, turn) => sum + turn.outputTokens, 0)).toBe(500);
    expect(stamp.turnUsage!.at(-1)).toMatchObject({ inputTokens: 3 * 151, outputTokens: 2 * 151 });
  });
});
