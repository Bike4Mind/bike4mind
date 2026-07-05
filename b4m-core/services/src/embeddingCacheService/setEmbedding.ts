import { Logger } from '@bike4mind/observability';
import { IEmbeddingCacheRepository } from '@bike4mind/common';
import { generateCacheKey } from './generateCacheKey';

interface SetEmbeddingAdapters {
  cache: IEmbeddingCacheRepository;
}

/**
 * Cache an embedding for future reuse.
 *
 * @param text - The text that was embedded
 * @param model - The embedding model name
 * @param vector - The embedding vector
 * @param tokenCount - Number of tokens in the text
 * @param adapters - Adapter for cache operations
 */
export async function setEmbedding(
  text: string,
  model: string,
  vector: number[],
  tokenCount: number,
  { cache }: SetEmbeddingAdapters
): Promise<void> {
  const contentHash = generateCacheKey(text, model);

  try {
    const now = new Date();
    await cache.upsert({
      contentHash,
      vector,
      model,
      tokenCount,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // Log but don't throw - cache failures shouldn't break the application
    Logger.globalInstance.error('Error saving to embedding cache:', error);
  }
}
