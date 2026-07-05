import { BedrockEmbeddingModel, ModelBackend } from '@bike4mind/common';

// Determine which provider is needed based on the embedding model
export const getProviderFromModel = (
  modelName: string
): ModelBackend.OpenAI | ModelBackend.VoyageAI | ModelBackend.Bedrock => {
  // Check if it's a Bedrock model
  if (Object.values(BedrockEmbeddingModel).includes(modelName as BedrockEmbeddingModel)) {
    return ModelBackend.Bedrock;
  }

  // Check if it's a VoyageAI model
  if (modelName.startsWith('voyage-')) {
    return ModelBackend.VoyageAI;
  }

  // Default to OpenAI for text-embedding models
  return ModelBackend.OpenAI;
};
