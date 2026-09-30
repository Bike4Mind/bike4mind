import { BedrockEmbeddingModel, OpenAIEmbeddingModel, VoyageAIEmbeddingModel } from '@bike4mind/common';
import { EmbeddingModelProvider, type EmbeddingModelInfo } from '@bike4mind/fab-pipeline';
import { describe, expect, it } from 'vitest';
import { planEmbeddingDimensions } from './planEmbeddingDimensions';

const info = (model: string, dimensions: number[]): EmbeddingModelInfo<string> => ({
  provider: EmbeddingModelProvider.OPENAI,
  model,
  contextWindow: 8192,
  dimensions,
});

describe('planEmbeddingDimensions', () => {
  it('uses the native width when none is requested or the native one is', () => {
    const small = info(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, [1536]);
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, small, undefined)).toEqual({
      kind: 'native',
    });
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, small, 1536)).toEqual({
      kind: 'native',
    });
  });

  it('truncates a Matryoshka OpenAI model to any width up to its native one', () => {
    const small = info(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, [1536]);
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, small, 1024)).toEqual({
      kind: 'truncate',
      dimensions: 1024,
    });
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, small, 2048).kind).toBe('unsupported');
  });

  it('refuses to truncate ada-002, whose prefix is not a smaller embedding', () => {
    const ada = info(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, [1536]);
    expect(planEmbeddingDimensions(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, ada, 512)).toEqual({
      kind: 'unsupported',
      message: 'text-embedding-ada-002 supports dimensions: 1536.',
    });
  });

  it('lets Voyage shorten natively, but only to a published width', () => {
    const voyage = info(VoyageAIEmbeddingModel.VOYAGE_3_LARGE, [1024, 256, 512, 2048]);
    expect(planEmbeddingDimensions(VoyageAIEmbeddingModel.VOYAGE_3_LARGE, voyage, 512)).toEqual({
      kind: 'provider',
      outputDimension: 512,
    });
    expect(planEmbeddingDimensions(VoyageAIEmbeddingModel.VOYAGE_3_LARGE, voyage, 300)).toEqual({
      kind: 'unsupported',
      message: 'voyage-3-large supports dimensions: 1024, 256, 512, 2048.',
    });
  });

  it('accepts only the native width on a provider that ignores outputDimension', () => {
    // Titan publishes 512 but BedrockEmbeddingService never forwards it, so offering it would lie.
    const titan = info(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2, [1024, 512, 256]);
    expect(planEmbeddingDimensions(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2, titan, 512)).toEqual({
      kind: 'unsupported',
      message: 'amazon.titan-embed-text-v2:0 supports dimensions: 1024.',
    });
  });
});
