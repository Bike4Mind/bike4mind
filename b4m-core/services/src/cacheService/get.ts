import { ICacheRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const getParamsSchema = z.object({
  key: z.string(),
});

export const get = async <TSchema extends z.ZodType>(
  params: z.infer<typeof getParamsSchema>,
  {
    db,
    schema,
  }: {
    db: {
      caches: ICacheRepository;
    };
    /**
     * The schema to parse the cache result with.
     * The type of the return value will be inferred from this schema.
     */
    schema: TSchema;
  }
): Promise<z.infer<TSchema> | null> => {
  const { key } = secureParameters(params, getParamsSchema);

  const cache = await db.caches.findByKey(key);
  if (cache) {
    return schema.parse(cache.result);
  }

  return null;
};
