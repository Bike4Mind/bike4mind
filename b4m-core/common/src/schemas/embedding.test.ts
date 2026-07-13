import { describe, it, expect, vi } from 'vitest';
import { getEmbeddingModelCost, OpenAIEmbeddingModel, VoyageAIEmbeddingModel } from './embedding';

describe('getEmbeddingModelCost', () => {
  it('prices a known OpenAI model at its per-token rate', () => {
    // text-embedding-3-small is $0.02 / 1M tokens.
    expect(getEmbeddingModelCost(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 1_000_000)).toBeCloseTo(0.02, 10);
    expect(getEmbeddingModelCost(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 0)).toBe(0);
  });

  it('prices a known Voyage model', () => {
    expect(getEmbeddingModelCost(VoyageAIEmbeddingModel.VOYAGE_3, 1_000_000)).toBeCloseTo(0.06, 10);
  });

  it('settles $0 and alarms for an unpriced model with real usage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getEmbeddingModelCost('made-up-embedding-model', 500)).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('UNPRICED_EMBEDDING_MODEL'));
    spy.mockRestore();
  });

  it('does not alarm for an unpriced model with zero usage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getEmbeddingModelCost('made-up-embedding-model', 0)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
