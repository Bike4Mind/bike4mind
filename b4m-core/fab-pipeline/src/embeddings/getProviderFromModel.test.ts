import { describe, it, expect } from 'vitest';
import { BedrockEmbeddingModel, ModelBackend } from '@bike4mind/common';
import { getProviderFromModel } from './getProviderFromModel';

describe('getProviderFromModel', () => {
  it('routes every Bedrock model ID to ModelBackend.Bedrock', () => {
    for (const model of Object.values(BedrockEmbeddingModel)) {
      expect(getProviderFromModel(model)).toBe(ModelBackend.Bedrock);
    }
  });

  it.each(['voyage-3', 'voyage-large-2'])('routes VoyageAI prefix model "%s" to ModelBackend.VoyageAI', model => {
    expect(getProviderFromModel(model)).toBe(ModelBackend.VoyageAI);
  });

  it.each(['text-embedding-3-small', 'text-embedding-3-large'])(
    'routes known OpenAI model "%s" to ModelBackend.OpenAI',
    model => {
      expect(getProviderFromModel(model)).toBe(ModelBackend.OpenAI);
    }
  );

  it('falls back to ModelBackend.OpenAI for unknown model IDs', () => {
    expect(getProviderFromModel('unknown-model-xyz')).toBe(ModelBackend.OpenAI);
  });
});
