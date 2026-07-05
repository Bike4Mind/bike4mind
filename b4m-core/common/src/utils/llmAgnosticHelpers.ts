import { SupportedEmbeddingModel } from '../schemas/embedding';

export function getEmbeddingProvider(model: SupportedEmbeddingModel): 'openai' | 'voyageai' {
  return model.startsWith('voyage-') ? 'voyageai' : 'openai';
}
