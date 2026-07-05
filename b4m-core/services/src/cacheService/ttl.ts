import { ICacheRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { dayjs } from '@bike4mind/common';

const ttlParamsSchema = z.object({
  key: z.string(),
});

/**
 * Get the time left before a cache key expires
 */
export async function ttl(
  params: z.infer<typeof ttlParamsSchema>,
  {
    db,
  }: {
    db: {
      caches: ICacheRepository;
    };
  }
): Promise<number> {
  const { key } = secureParameters(params, ttlParamsSchema);

  const cache = await db.caches.findByKey(key);

  if (cache) {
    const timeLeft = dayjs(cache.expiresAt).diff(dayjs(), 'milliseconds');
    return timeLeft;
  }

  return 0;
}
