import { ICacheRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

interface GetCachedDataOptions {
  db: {
    caches: Pick<ICacheRepository, 'findByKey' | 'createOrUpdate'>;
  };
  /** The expiry time for the cache in milliseconds */
  expiry: number;
  recache?: boolean;
  logger?: Logger;
}

/**
 * Read-through cache helper: returns the cached value for `key`, or runs
 * `callback`, stores its result with the given expiry, and returns it. Pass
 * `recache: true` to bypass an existing entry and refresh it.
 */
export async function getCachedData<T>(
  key: string,
  callback: () => Promise<T>,
  { db, expiry, recache, logger }: GetCachedDataOptions
): Promise<T> {
  const cachedResult = await db.caches.findByKey(key);

  if (cachedResult && !recache) {
    logger?.log(`Cache hit for key: ${key}`);
    return cachedResult.result as T;
  }

  logger?.log(`Cache miss for key: ${key}`);

  const result = await callback();

  await db.caches.createOrUpdate({
    key,
    result,
    expiresAt: new Date(Date.now() + expiry),
  });

  return result;
}
