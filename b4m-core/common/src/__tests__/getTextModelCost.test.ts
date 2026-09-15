import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getTextModelCost, ModelBackend, type ModelInfo } from '../models';

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
