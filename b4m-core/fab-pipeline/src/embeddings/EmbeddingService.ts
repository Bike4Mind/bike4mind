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
