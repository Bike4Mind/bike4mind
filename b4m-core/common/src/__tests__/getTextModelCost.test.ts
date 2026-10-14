import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTextModelCost, getTurnsCost, pricingTierForTokens, ModelBackend, type ModelInfo } from '../models';

const baseModel: ModelInfo = {
  id: 'test-model' as ModelInfo['id'],
  type: 'text',
  name: 'Test Model',
  backend: ModelBackend.OpenAI,
  contextWindow: 200_000,
  max_tokens: 4096,
  pricing: { 200_000: { input: 10 / 1_000_000, output: 30 / 1_000_000 } },
  supportsImageVariation: false,
};

describe('getTextModelCost unpriced-model alarm', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('does not alarm on a priced model', () => {
    const cost = getTextModelCost(baseModel, 100, 50);
    expect(cost).toBeGreaterThan(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('alarms when a model with an empty pricing map settles nonzero usage', () => {
    const unpriced: ModelInfo = { ...baseModel, pricing: {} };
    const cost = getTextModelCost(unpriced, 100, 50);
    expect(cost).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[UNPRICED_MODEL]');
    expect(String(errorSpy.mock.calls[0][0])).toContain('test-model');
  });

  it('alarms when zero-rate pricing settles nonzero usage without freeToRun', () => {
    const zeroRate: ModelInfo = {
      ...baseModel,
      pricing: { 200_000: { input: 0, output: 0 } },
    };
    getTextModelCost(zeroRate, 100, 50);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[UNPRICED_MODEL]');
  });

  it('does not alarm on a freeToRun model (local Ollama publishes zero rates deliberately)', () => {
    const free: ModelInfo = {
      ...baseModel,
      freeToRun: true,
      pricing: { 200_000: { input: 0, output: 0 } },
    };
    const cost = getTextModelCost(free, 100, 50);
    expect(cost).toBe(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not alarm on zero usage (empty calls are not evidence of a missing price)', () => {
    const unpriced: ModelInfo = { ...baseModel, pricing: {} };
    getTextModelCost(unpriced, 0, 0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('alarms on cache-only usage against an unpriced model', () => {
    const unpriced: ModelInfo = { ...baseModel, pricing: {} };
    getTextModelCost(unpriced, 0, 0, 3000, 500);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('pricingTierForTokens', () => {
  const tier = (input: number) => ({ input, output: input });
  const tiered = { ...baseModel, pricing: { 50_000: tier(1), 200_000: tier(2) } } as ModelInfo;

  it('picks the smallest tier covering the tokens', () => {
    expect(pricingTierForTokens(tiered, 10_000)).toBe(50_000);
  });

  it('keeps a token count equal to a threshold in that tier', () => {
    expect(pricingTierForTokens(tiered, 50_000)).toBe(50_000);
    expect(pricingTierForTokens(tiered, 50_001)).toBe(200_000);
  });

  it('falls back to the largest tier above every threshold', () => {
    expect(pricingTierForTokens(tiered, 500_000)).toBe(200_000);
  });

  it('returns null for an empty pricing map', () => {
    expect(pricingTierForTokens({ ...baseModel, pricing: {} } as ModelInfo, 100)).toBeNull();
  });
});

const perM = (usd: number) => usd / 1_000_000;

// Two-tier ladders shaped like gpt-5.4 (272K) and gemini-3.1-pro-preview (200K).
const gpt54 = {
  ...baseModel,
  pricing: {
    272_000: { input: perM(2.5), cache_read: perM(0.25), output: perM(15) },
    1_050_000: { input: perM(5), cache_read: perM(0.5), output: perM(22.5) },
  },
} as ModelInfo;
const geminiPro = {
  ...baseModel,
  backend: ModelBackend.Gemini,
  pricing: {
    200_000: { input: perM(2), output: perM(12) },
    1_048_576: { input: perM(4), output: perM(18) },
  },
} as ModelInfo;

describe('getTurnsCost', () => {
  it('picks the tier on the whole cache-inclusive prompt, not the uncached tail', () => {
    // 300K prompt, 280K of it cached: OpenAI applies the >272K rate to the whole request.
    const turns = [{ inputTokens: 20_000, cacheReadInputTokens: 280_000, outputTokens: 2_000 }];
    expect(getTurnsCost(gpt54, turns)).toBeCloseTo(0.285, 10);
    // The aggregate path picks the tier on the uncached 20K and underbills.
    expect(getTextModelCost(gpt54, 20_000, 2_000, 280_000)).toBeCloseTo(0.15, 10);
  });

  it('prices each tool round-trip on its own prompt instead of the summed total', () => {
    const turn = { inputTokens: 80_000, outputTokens: 1_000 };
    expect(getTurnsCost(geminiPro, [turn, turn, turn])).toBeCloseTo(0.516, 10);
    expect(getTextModelCost(geminiPro, 240_000, 3_000)).toBeCloseTo(1.014, 10);
  });

  it('bills only the turns that cross the threshold at the long rate', () => {
    const turns = [
      { inputTokens: 150_000, outputTokens: 1_000 },
      { inputTokens: 190_000, outputTokens: 1_000 },
      { inputTokens: 230_000, outputTokens: 1_000 },
    ];
    const base = 340_000 * perM(2) + 2_000 * perM(12);
    const long = 230_000 * perM(4) + 1_000 * perM(18);
    expect(getTurnsCost(geminiPro, turns)).toBeCloseTo(base + long, 10);
  });

  it.each([
    [200_000, 'base'],
    [200_001, 'long'],
  ])('keeps a %i-token prompt split across input and cache in the %s tier', (prompt, expected) => {
    const rates = expected === 'base' ? geminiPro.pricing[200_000] : geminiPro.pricing[1_048_576];
    const cached = 50_000;
    const turn = { inputTokens: prompt - cached, cacheReadInputTokens: cached, outputTokens: 0 };
    expect(getTurnsCost(geminiPro, [turn])).toBeCloseTo(
      (prompt - cached) * rates.input + cached * rates.input * 0.1,
      12
    );
  });

  it('counts cache writes toward the tier', () => {
    const turn = { inputTokens: 1_000, cacheCreationInputTokens: 272_000, outputTokens: 0 };
    expect(getTurnsCost(gpt54, [turn])).toBeCloseTo(1_000 * perM(5) + 272_000 * perM(5) * 1.25, 10);
  });

  it('matches getTextModelCost for a single turn under the first threshold', () => {
    const turn = { inputTokens: 5_000, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 300, outputTokens: 700 };
    expect(getTurnsCost(gpt54, [turn])).toBeCloseTo(getTextModelCost(gpt54, 5_000, 700, 2_000, 300), 12);
  });

  it('returns 0 for no turns', () => {
    expect(getTurnsCost(gpt54, [])).toBe(0);
  });

  it('keeps the unpriced-model alarm', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getTurnsCost({ ...baseModel, pricing: {} }, [{ inputTokens: 100, outputTokens: 10 }]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[UNPRICED_MODEL]');
    errorSpy.mockRestore();
  });

  it('alarms once when a single turn prices at $0 inside an otherwise priced chain', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const zeroUpperTier = {
      ...baseModel,
      pricing: {
        200_000: { input: perM(2), output: perM(12) },
        1_048_576: { input: 0, output: 0 },
      },
    } as ModelInfo;
    const short = { inputTokens: 1_000, outputTokens: 100 };
    const long = { inputTokens: 250_000, outputTokens: 100 };
    expect(getTurnsCost(zeroUpperTier, [short, long])).toBeCloseTo(getTurnsCost(zeroUpperTier, [short]), 12);
    errorSpy.mockClear();
    getTurnsCost(zeroUpperTier, [short, long]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('[UNPRICED_MODEL]');
    errorSpy.mockRestore();
  });

  it('alarms once, not per turn, for a chain on an unpriced model', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const turn = { inputTokens: 100, outputTokens: 10 };
    getTurnsCost({ ...baseModel, pricing: {} }, [turn, turn, turn]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe('getTextModelCost tierBasisTokens', () => {
  it('picks the tier on the given basis while pricing the given counts', () => {
    expect(getTextModelCost(gpt54, 20_000, 0, 0, 0, 300_000)).toBeCloseTo(20_000 * perM(5), 10);
  });
});
