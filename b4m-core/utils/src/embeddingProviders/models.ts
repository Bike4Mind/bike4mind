import {
  EMBEDDING_MODEL_CATALOG,
  EMBEDDING_MODEL_IDS,
  type EmbeddingProviderId,
  type EmbeddingModelId,
} from '@bike4mind/common';

/** Every catalog model the given provider serves, so a provider never hand-lists its models. */
export const embeddingModelsOf = (provider: EmbeddingProviderId): readonly EmbeddingModelId[] =>
  EMBEDDING_MODEL_IDS.filter(model => EMBEDDING_MODEL_CATALOG[model].provider === provider);
