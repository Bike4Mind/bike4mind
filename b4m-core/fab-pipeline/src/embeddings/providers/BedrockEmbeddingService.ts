import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { EmbeddingModelInfo, EmbeddingModelProvider, EmbeddingService } from '../EmbeddingService';
import { BedrockEmbeddingModel } from '@bike4mind/common';

export const BEDROCK_EMBEDDING_MODEL_MAP: Record<BedrockEmbeddingModel, EmbeddingModelInfo<BedrockEmbeddingModel>> = {
  [BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2]: {
    provider: EmbeddingModelProvider.BEDROCK,
    model: BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2,
    contextWindow: 8192,
    dimensions: [1024, 512, 256],
  },
};

export interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export class BedrockEmbeddingService implements EmbeddingService {
  private client: BedrockRuntimeClient;
  private model: BedrockEmbeddingModel;

  constructor(model: BedrockEmbeddingModel = BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2) {
    this.client = new BedrockRuntimeClient();
    this.validateModel(model);
    this.model = model;
  }

  private validateModel(model: BedrockEmbeddingModel): void {
    if (!BEDROCK_EMBEDDING_MODEL_MAP[model]) {
      throw new Error(`Invalid Bedrock embedding model: ${model}`);
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const input = this.formatInput(text);
    const command = new InvokeModelCommand({
      modelId: this.model,
      body: JSON.stringify(input),
    });

    const response = await this.client.send(command);
    const responseBody = new TextDecoder().decode(response.body);
    return this.parseResponse(responseBody);
  }

  private formatInput(text: string): Record<string, any> {
    return {
      inputText: text,
    };
  }

  private parseResponse(responseBody: string): number[] {
    try {
      const response = JSON.parse(responseBody);
      return response.embedding;
    } catch (error) {
      throw new Error('Failed to parse Bedrock embedding response');
    }
  }

  getModelInfo(): EmbeddingModelInfo<BedrockEmbeddingModel> {
    return BEDROCK_EMBEDDING_MODEL_MAP[this.model];
  }
}
