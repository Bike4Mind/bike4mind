import { z } from 'zod';

export enum OpenAIEmbeddingModel {
  TEXT_EMBEDDING_3_SMALL = 'text-embedding-3-small',
  TEXT_EMBEDDING_3_LARGE = 'text-embedding-3-large',
  TEXT_EMBEDDING_ADA_002 = 'text-embedding-ada-002',
}

export enum VoyageAIEmbeddingModel {
  VOYAGE_3_LARGE = 'voyage-3-large',
  VOYAGE_3 = 'voyage-3',
  VOYAGE_3_LITE = 'voyage-3-lite',
  VOYAGE_CODE_3 = 'voyage-code-3',
  VOYAGE_FINANCE_3 = 'voyage-finance-3',
  VOYAGE_LAW_3 = 'voyage-law-3',
}

export enum BedrockEmbeddingModel {
  TITAN_TEXT_EMBEDDINGS_V2 = 'amazon.titan-embed-text-v2:0',
  // As of 2025-03-27, titan-embed-text-v2:0 is the only supported model for us-east-2 region.
}

export const SupportedEmbeddingModelSchema = z.union([
  z.enum(OpenAIEmbeddingModel),
  z.enum(VoyageAIEmbeddingModel),
  z.enum(BedrockEmbeddingModel),
]);

export type SupportedEmbeddingModel = z.infer<typeof SupportedEmbeddingModelSchema>;

export function isSupportedEmbeddingModel(model: string): model is SupportedEmbeddingModel {
  return SupportedEmbeddingModelSchema.safeParse(model).success;
}
