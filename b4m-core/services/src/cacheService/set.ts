import { ICacheRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { dayjs } from '@bike4mind/common';

const setParamsSchema = z.object({
  key: z.string(),
  value: z.any(),
  /**
   * Time to live in milliseconds
   */
  ttl: z.number(),
  recache: z.boolean().optional(),
});

export async function set<T>(
  params: z.infer<typeof setParamsSchema>,
  {
    db,
  }: {
    db: {
      caches: ICacheRepository;
    };
  }
) {
  const { key, value, ttl, recache } = secureParameters(params, setParamsSchema);

  const cache = await db.caches.findByKey(key);

  if (cache && recache) {
    await db.caches.deleteByKey(key);
  }

  const expiresAt = dayjs().add(ttl, 'milliseconds').toDate();

  await db.caches.createOrUpdate({ key, result: value, expiresAt });

  return value as T;
}
