import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTextModelCost, pricingTierForTokens, ModelBackend, type ModelInfo } from '../models';

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

describe('getTextModelCost tier selection', () => {
  const tiered = {
    id: 'tiered',
    backend: ModelBackend.OpenAI,
    pricing: {
      272000: { input: 0.000005, output: 0.00003 },
      1050000: { input: 0.00001, output: 0.000045 },
    },
  } as unknown as ModelInfo;

  it('prices a prompt that is mostly cache reads at the tier its whole size falls in', () => {
    // 10K new + 290K cached = 300K: past the 272K threshold, so the long-context rates apply.
    const cost = getTextModelCost(tiered, 10_000, 1_000, 290_000);
    expect(cost).toBeCloseTo(10_000 * 0.00001 + 1_000 * 0.000045 + 290_000 * 0.000001, 9);
  });

  it('counts cache writes toward the prompt size too', () => {
    const cost = getTextModelCost(tiered, 0, 0, 0, 300_000);
    expect(cost).toBeCloseTo(300_000 * 0.00001 * 1.25, 9);
  });

  it('keeps the short tier when the whole prompt fits in it', () => {
    const cost = getTextModelCost(tiered, 10_000, 1_000, 200_000);
    expect(cost).toBeCloseTo(10_000 * 0.000005 + 1_000 * 0.00003 + 200_000 * 0.0000005, 9);
  });
});
