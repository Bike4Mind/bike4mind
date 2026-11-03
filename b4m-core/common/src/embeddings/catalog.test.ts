import { describe, expect, it } from 'vitest';
import { SupportedEmbeddingModelSchema, VoyageAIEmbeddingModel } from '../schemas/embedding';
import { EMBEDDING_MODEL_CATALOG, EMBEDDING_MODEL_IDS, servableEmbeddingDimensions } from './catalog';

describe('EMBEDDING_MODEL_CATALOG', () => {
  it('declares only supported model ids (the Record type forces every one to be present)', () => {
    for (const id of EMBEDDING_MODEL_IDS) {
      expect(SupportedEmbeddingModelSchema.safeParse(id).success).toBe(true);
    }
  });

  it.each(EMBEDDING_MODEL_IDS)('%s has a coherent width declaration', id => {
    const { dimensions, maxInputTokens } = EMBEDDING_MODEL_CATALOG[id];
    expect(maxInputTokens).toBeGreaterThan(0);
    if (dimensions.kind === 'range') {
      expect(dimensions.min).toBeGreaterThanOrEqual(1);
      expect(dimensions.min).toBeLessThanOrEqual(dimensions.native);
    }
    if (dimensions.kind === 'discrete') {
      expect(dimensions.values).toContain(dimensions.native);
    }
  });

  it.each(EMBEDDING_MODEL_IDS)('%s is declared discrete only if its provider forwards outputDimension', id => {
    const { dimensions, provider } = EMBEDDING_MODEL_CATALOG[id];
    // Only fab-pipeline VoyageAIEmbeddingService forwards a width; any other provider would silently serve native.
    if (dimensions.kind === 'discrete') expect(provider).toBe('voyage');
  });
});

describe('servableEmbeddingDimensions', () => {
  it('lists the native width first, then the other published widths', () => {
    expect(servableEmbeddingDimensions(EMBEDDING_MODEL_CATALOG[VoyageAIEmbeddingModel.VOYAGE_3_LARGE])).toEqual([
      1024, 256, 512, 2048,
    ]);
  });

  it('lists only the native width for range and fixed models', () => {
    expect(servableEmbeddingDimensions(EMBEDDING_MODEL_CATALOG['text-embedding-3-small'])).toEqual([1536]);
    expect(servableEmbeddingDimensions(EMBEDDING_MODEL_CATALOG['amazon.titan-embed-text-v2:0'])).toEqual([1024]);
  });
});
