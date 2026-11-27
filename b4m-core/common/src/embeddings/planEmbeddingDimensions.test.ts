import { BedrockEmbeddingModel, OpenAIEmbeddingModel, VoyageAIEmbeddingModel } from '../schemas/embedding';
import { describe, expect, it } from 'vitest';
import { planEmbeddingDimensions } from './planEmbeddingDimensions';

describe('planEmbeddingDimensions', () => {
  it('uses the native width when none is requested or the native one is', () => {
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, undefined)).toEqual({
      kind: 'native',
    });
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 1536)).toEqual({
      kind: 'native',
    });
  });

  it('truncates a Matryoshka OpenAI model to any width up to its native one', () => {
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 1024)).toEqual({
      kind: 'truncate',
      dimensions: 1024,
    });
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 2048).kind).toBe('unsupported');
  });

  it('refuses to truncate ada-002, whose prefix is not a smaller embedding', () => {
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, 512)).toEqual({
      kind: 'unsupported',
      message: 'text-embedding-ada-002 supports dimensions: 1536.',
    });
  });

  it('lets Voyage shorten natively, but only to a published width', () => {
    expect(planEmbeddingDimensions(VoyageAIEmbeddingModel.VOYAGE_3_LARGE, 512)).toEqual({
      kind: 'provider',
      outputDimension: 512,
    });
    expect(planEmbeddingDimensions(VoyageAIEmbeddingModel.VOYAGE_3_LARGE, 300)).toEqual({
      kind: 'unsupported',
      message: 'voyage-3-large supports dimensions: 1024, 256, 512, 2048.',
    });
  });

  it('accepts only the native width on a provider that ignores outputDimension', () => {
    expect(planEmbeddingDimensions(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2, 512)).toEqual({
      kind: 'unsupported',
      message: 'amazon.titan-embed-text-v2:0 supports dimensions: 1024.',
    });
  });
});
