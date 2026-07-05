import { ITagRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const tagUpdateSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
});

export type TagUpdateParams = z.infer<typeof tagUpdateSchema>;

interface TagUpdateAdapters {
  db: {
    tags: Pick<ITagRepository, 'update' | 'findByIdAndUserId'>;
  };
}

export const update = async (userId: string, params: TagUpdateParams, adapters: TagUpdateAdapters) => {
  const { db } = adapters;
  const { id, ...rest } = secureParameters(params, tagUpdateSchema);

  const tag = await db.tags.findByIdAndUserId(id, userId);

  if (!tag) {
    throw new Error('Tag Service - Update: Tag not found');
  }

  const buildData = {
    id,
    ...rest,
    updatedAt: new Date(),
  };

  await db.tags.update(buildData);

  return buildData;
};
