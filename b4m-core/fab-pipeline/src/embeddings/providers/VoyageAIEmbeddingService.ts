import { VoyageAIClient } from 'voyageai';
import { EmbeddingModelInfo, EmbeddingService, embeddingModelInfoMap } from '../EmbeddingService';
import { VoyageAIEmbeddingModel } from '@bike4mind/common';

export const VOYAGEAI_EMBEDDING_MODEL_MAP = embeddingModelInfoMap(Object.values(VoyageAIEmbeddingModel));

export class VoyageAIEmbeddingProvider implements EmbeddingService {
  private client: VoyageAIClient;
  private model: VoyageAIEmbeddingModel;

  constructor(apiKey: string, model: VoyageAIEmbeddingModel = VoyageAIEmbeddingModel.VOYAGE_3) {
    this.client = new VoyageAIClient({ apiKey });
    this.validateModel(model);
    this.model = model;
  }

  private validateModel(model: VoyageAIEmbeddingModel): void {
    if (!VOYAGEAI_EMBEDDING_MODEL_MAP[model]) {
      throw new Error(`Invalid Voyage AI embedding model: ${model}`);
    }
  }

  async generateEmbedding(text: string, options?: { outputDimension?: number }): Promise<number[]> {
    const response = await this.client.embed({
      input: text,
      model: this.model,
      outputDimension: options?.outputDimension ?? this.getModelInfo().dimensions[0],
    });

    if (response.data && response.data[0].embedding) {
      return response.data[0].embedding;
    } else {
      throw new Error('No embedding data received from Voyage AI');
    }
  }

  getModelInfo(): EmbeddingModelInfo<VoyageAIEmbeddingModel> {
    return VOYAGEAI_EMBEDDING_MODEL_MAP[this.model];
  }
}
