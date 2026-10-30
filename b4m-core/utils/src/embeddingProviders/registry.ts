import {
  EMBEDDING_MODEL_CATALOG,
  EMBEDDING_MODEL_IDS,
  type EmbeddingProviderId,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { createGenerationProviderRegistry, type GenerationProviderRegistry } from '../generationProviders/registry';
import type { EmbeddingProvider } from './types';

export type EmbeddingProviderRegistry = GenerationProviderRegistry<EmbeddingProviderId, EmbeddingProvider>;

export const createEmbeddingProviderRegistry = (providers: readonly EmbeddingProvider[]): EmbeddingProviderRegistry =>
  createGenerationProviderRegistry<EmbeddingProviderId, SupportedEmbeddingModel, EmbeddingProvider>(
    { label: 'embedding', modelIds: EMBEDDING_MODEL_IDS, providerOf: model => EMBEDDING_MODEL_CATALOG[model].provider },
    providers
  );
