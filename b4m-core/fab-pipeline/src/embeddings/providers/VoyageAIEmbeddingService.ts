import { VoyageAIClient } from 'voyageai';
import { EmbeddingModelInfo, EmbeddingModelProvider, EmbeddingService } from '../EmbeddingService';
import { VoyageAIEmbeddingModel } from '@bike4mind/common';

export const VOYAGEAI_EMBEDDING_MODEL_MAP: Record<
  VoyageAIEmbeddingModel,
  EmbeddingModelInfo<VoyageAIEmbeddingModel>
> = {
  [VoyageAIEmbeddingModel.VOYAGE_3_LARGE]: {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    model: VoyageAIEmbeddingModel.VOYAGE_3_LARGE,
    contextWindow: 32000,
    dimensions: [1024, 256, 512, 2048],
  },
  [VoyageAIEmbeddingModel.VOYAGE_3]: {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    model: VoyageAIEmbeddingModel.VOYAGE_3,
    contextWindow: 32000,
    dimensions: [1024],
  },
  [VoyageAIEmbeddingModel.VOYAGE_3_LITE]: {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    model: VoyageAIEmbeddingModel.VOYAGE_3_LITE,
    contextWindow: 32000,
    dimensions: [512],
  },
  [VoyageAIEmbeddingModel.VOYAGE_CODE_3]: {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    model: VoyageAIEmbeddingModel.VOYAGE_CODE_3,
    contextWindow: 32000,
    dimensions: [1024, 256, 512, 2048],
  },
  [VoyageAIEmbeddingModel.VOYAGE_FINANCE_3]: {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    model: VoyageAIEmbeddingModel.VOYAGE_FINANCE_3,
    contextWindow: 32000,
    dimensions: [1024],
  },
  [VoyageAIEmbeddingModel.VOYAGE_LAW_3]: {
    provider: EmbeddingModelProvider.VOYAGE_AI,
    model: VoyageAIEmbeddingModel.VOYAGE_LAW_3,
    contextWindow: 16000,
    dimensions: [1024],
  },
};

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
