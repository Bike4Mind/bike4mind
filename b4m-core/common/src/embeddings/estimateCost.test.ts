import { describe, it, expect, vi } from 'vitest';
import { OllamaEmbeddingModel, OpenAIEmbeddingModel, VoyageAIEmbeddingModel } from '../schemas/embedding';
import { getEmbeddingModelCost, hasPublishedEmbeddingRate } from './estimateCost';

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

  it('prices local Ollama embedders at $0 without alarming', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getEmbeddingModelCost(OllamaEmbeddingModel.NOMIC_EMBED_TEXT, 1_000_000)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('hasPublishedEmbeddingRate', () => {
  it('is true for a priced model and for an explicit $0 local embedder', () => {
    expect(hasPublishedEmbeddingRate(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL)).toBe(true);
    expect(hasPublishedEmbeddingRate(OllamaEmbeddingModel.NOMIC_EMBED_TEXT)).toBe(true);
  });

  it('is false for a catalog model without a rate and for an unknown id', () => {
    expect(hasPublishedEmbeddingRate(VoyageAIEmbeddingModel.VOYAGE_FINANCE_3)).toBe(false);
    expect(hasPublishedEmbeddingRate('made-up-embedding-model')).toBe(false);
    expect(hasPublishedEmbeddingRate('constructor')).toBe(false);
  });
});
