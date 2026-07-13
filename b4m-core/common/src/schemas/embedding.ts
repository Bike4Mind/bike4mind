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

/**
 * Public list price in USD per input token, by embedding model. Embeddings bill on
 * input tokens only (no output). These are list prices for COGS estimation, not a
 * contract; update alongside provider price changes. Models absent here settle at
 * $0 with an alarm (see getEmbeddingModelCost) so a missing rate never blocks the
 * usage-event write nor silently over-bills.
 */
const EMBEDDING_MODEL_PRICE_PER_TOKEN: Partial<Record<SupportedEmbeddingModel, number>> = {
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL]: 0.02 / 1_000_000,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE]: 0.13 / 1_000_000,
  [OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002]: 0.1 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_3_LARGE]: 0.18 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_3]: 0.06 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_3_LITE]: 0.02 / 1_000_000,
  [VoyageAIEmbeddingModel.VOYAGE_CODE_3]: 0.18 / 1_000_000,
  [BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2]: 0.02 / 1_000_000,
};

/** Compute USD cost for an embedding call. Unpriced models settle $0 with an alarm. */
export const getEmbeddingModelCost = (model: string, inputTokens: number): number => {
  const rate = EMBEDDING_MODEL_PRICE_PER_TOKEN[model as SupportedEmbeddingModel];
  if (rate === undefined) {
    if (inputTokens > 0) {
      console.error(`[UNPRICED_EMBEDDING_MODEL] ${model} computed $0 for ${inputTokens} tokens; add its rate`);
    }
    return 0;
  }
  return rate * inputTokens;
};
