import { Logger } from '@bike4mind/observability';
import { IEmbeddingCacheRepository } from '@bike4mind/common';
import { generateCacheKey } from './generateCacheKey';

interface GetEmbeddingAdapters {
  cache: IEmbeddingCacheRepository;
}

/**
 * Get a cached embedding if it exists.
 * Updates access tracking metrics when found.
 *
 * @param text - The text to look up
 * @param model - The embedding model name
 * @param adapters - Adapter for cache operations
 * @returns The cached embedding vector, or null if not found
 */
export async function getEmbedding(
  text: string,
  model: string,
  { cache }: GetEmbeddingAdapters
): Promise<number[] | null> {
  const contentHash = generateCacheKey(text, model);

  try {
    const cached = await cache.findByHash(contentHash, model);

    if (cached) {
      // Update access tracking (fire and forget, don't wait)
      cache.incrementAccessCount(contentHash, model).catch((error: unknown) => {
        Logger.globalInstance.error('Error updating access count:', error);
      });

      return cached.vector;
    }

    return null;
  } catch (error) {
    // Log but don't throw - cache failures shouldn't break the application
    Logger.globalInstance.error('Error retrieving from embedding cache:', error);
    return null;
  }
}
