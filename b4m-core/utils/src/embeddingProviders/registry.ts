import {
  EMBEDDING_MODEL_CATALOG,
  ApiBedrockEmbeddingModel,
  EMBEDDING_MODEL_IDS,
  type EmbeddingProviderId,
  type EmbeddingModelId,
} from '@bike4mind/common';
import { createGenerationProviderRegistry, type GenerationProviderRegistry } from '../generationProviders/registry';
import type { EmbeddingProvider } from './types';

export type EmbeddingProviderRegistry = GenerationProviderRegistry<EmbeddingProviderId, EmbeddingProvider>;

export const createEmbeddingProviderRegistry = (providers: readonly EmbeddingProvider[]): EmbeddingProviderRegistry =>
  createGenerationProviderRegistry<EmbeddingProviderId, EmbeddingModelId, EmbeddingProvider>(
    {
      label: 'embedding',
      modelIds: EMBEDDING_MODEL_IDS.filter(
        model =>
          model !== ApiBedrockEmbeddingModel.COHERE_EMBED_V4 ||
          providers.some(provider => provider.models.includes(model))
      ),
      providerOf: model => EMBEDDING_MODEL_CATALOG[model].provider,
    },
    providers
  );
