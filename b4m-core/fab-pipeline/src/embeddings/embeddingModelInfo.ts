import {
  EMBEDDING_MODEL_CATALOG,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
  BedrockEmbeddingModel,
  OllamaEmbeddingModel,
  servableEmbeddingDimensions,
  type EmbeddingProviderId,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';

export enum EmbeddingModelProvider {
  OPENAI = 'OpenAI',
  BEDROCK = 'Amazon Bedrock',
  VOYAGE_AI = 'Voyage AI',
  OLLAMA = 'Ollama',
  GEMINI = 'Gemini',
}

export type EmbeddingModelInfo<Model extends string> = {
  provider: EmbeddingModelProvider;
  model: Model;
  contextWindow: number;
  /**
   * The dimensions of the embedding.
   *
   * Some models may have multiple dimensions, so we need to specify which one we want to use.
   */
  dimensions: number[];
};

const PROVIDER_LABEL: Record<EmbeddingProviderId, EmbeddingModelProvider> = {
  openai: EmbeddingModelProvider.OPENAI,
  voyage: EmbeddingModelProvider.VOYAGE_AI,
  bedrock: EmbeddingModelProvider.BEDROCK,
  ollama: EmbeddingModelProvider.OLLAMA,
  gemini: EmbeddingModelProvider.GEMINI,
};

/** Per-provider model info, derived from EMBEDDING_MODEL_CATALOG so widths and input ceilings have one owner. */
export const embeddingModelInfoMap = <Model extends SupportedEmbeddingModel>(
  models: readonly Model[]
): Record<Model, EmbeddingModelInfo<Model>> =>
  Object.fromEntries(
    models.map(model => {
      const capabilities = EMBEDDING_MODEL_CATALOG[model];
      const info: EmbeddingModelInfo<Model> = {
        provider: PROVIDER_LABEL[capabilities.provider],
        model,
        contextWindow: capabilities.maxInputTokens,
        dimensions: servableEmbeddingDimensions(capabilities),
      };
      return [model, info];
    })
  ) as Record<Model, EmbeddingModelInfo<Model>>;

export const OPENAI_EMBEDDING_MODEL_MAP = embeddingModelInfoMap(Object.values(OpenAIEmbeddingModel));
export const VOYAGEAI_EMBEDDING_MODEL_MAP = embeddingModelInfoMap(Object.values(VoyageAIEmbeddingModel));
export const BEDROCK_EMBEDDING_MODEL_MAP = embeddingModelInfoMap(Object.values(BedrockEmbeddingModel));
export const OLLAMA_EMBEDDING_MODEL_MAP = embeddingModelInfoMap(Object.values(OllamaEmbeddingModel));
export const OPENAI_MAX_INPUTS_PER_REQUEST = 2048;
export const OPENAI_MAX_TOKENS_PER_INPUT = 8192;
export const OPENAI_EFFECTIVE_TOKEN_LIMIT = 270_000;
export const OPENAI_KEY_MISSING_MESSAGE =
  'OpenAI API key is not configured (found a missing or placeholder value). Set a real OPENAI_API_KEY, or for an airgapped self-host unset it and set OLLAMA_BASE_URL to use a local embedder.';
export const VOYAGE_KEY_MISSING_MESSAGE =
  'VoyageAI API key is not configured (found a missing or placeholder value). Set a real VOYAGE_API_KEY, or for an airgapped self-host set OLLAMA_BASE_URL to use a local embedder.';
