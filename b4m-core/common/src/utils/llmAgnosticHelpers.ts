import { BedrockEmbeddingModel, OllamaEmbeddingModel, SupportedEmbeddingModel } from '../schemas/embedding';

export function getEmbeddingProvider(model: SupportedEmbeddingModel): 'openai' | 'voyageai' | 'bedrock' | 'ollama' {
  if (Object.values(OllamaEmbeddingModel).includes(model as OllamaEmbeddingModel)) return 'ollama';
  if (Object.values(BedrockEmbeddingModel).includes(model as BedrockEmbeddingModel)) return 'bedrock';
  if (model.startsWith('voyage-')) return 'voyageai';
  return 'openai';
}
