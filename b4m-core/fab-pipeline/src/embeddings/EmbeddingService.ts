import {
  EMBEDDING_MODEL_CATALOG,
  servableEmbeddingDimensions,
  type EmbeddingProviderId,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';

export enum EmbeddingModelProvider {
  OPENAI = 'OpenAI',
  BEDROCK = 'Amazon Bedrock',
  VOYAGE_AI = 'Voyage AI',
  OLLAMA = 'Ollama',
}

export interface EmbeddingModelInfo<Model extends string> {
  provider: EmbeddingModelProvider;
  model: Model;
  contextWindow: number;
  /**
   * The dimensions of the embedding.
   *
   * Some models may have multiple dimensions, so we need to specify which one we want to use.
   */
  dimensions: number[];
}

export abstract class EmbeddingService {
  abstract generateEmbedding(
    text: string,
    options?: {
      /**
       * The dimension of the embedding to return.
       *
       * If not specified, the default dimension will be used, which is the first dimension in the dimensions array.
       */
      outputDimension?: number;
    }
  ): Promise<number[]>;
  abstract getModelInfo(): EmbeddingModelInfo<string>;
}

const PROVIDER_LABEL: Record<EmbeddingProviderId, EmbeddingModelProvider> = {
  openai: EmbeddingModelProvider.OPENAI,
  voyage: EmbeddingModelProvider.VOYAGE_AI,
  bedrock: EmbeddingModelProvider.BEDROCK,
  ollama: EmbeddingModelProvider.OLLAMA,
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
