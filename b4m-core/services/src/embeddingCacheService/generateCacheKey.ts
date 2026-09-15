import crypto from 'crypto';

/**
 * Generate a cache key for embedding based on text content and model.
 * Uses SHA-256 hash to create a deterministic, collision-resistant key.
 *
 * @param text - The text content to hash
 * @param model - The embedding model name
 * @returns Cache key in format: "contentHash"
 */
export function generateCacheKey(text: string, model: string): string {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return hash;
}
