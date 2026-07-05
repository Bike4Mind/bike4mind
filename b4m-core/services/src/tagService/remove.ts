import { secureParameters } from '@bike4mind/utils';
import { ITagRepository } from '@bike4mind/common';
import { z } from 'zod';

const tagRemoveSchema = z.object({
  id: z.string(),
});

type TagRemoveParams = z.infer<typeof tagRemoveSchema>;

interface TagRemoveAdapters {
  db: { tags: Pick<ITagRepository, 'findByIdAndUserId' | 'delete'> };
}

export const remove = async (userId: string, params: TagRemoveParams, adapters: TagRemoveAdapters) => {
  const { db } = adapters;
  const { id } = secureParameters(params, tagRemoveSchema);

  const tag = await db.tags.findByIdAndUserId(id, userId);

  if (!tag) {
    throw new Error('Tag Service - Delete: Tag not found');
  }

  await db.tags.delete(tag.id);
};
