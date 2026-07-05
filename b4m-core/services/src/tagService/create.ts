import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { IFileTagRepository, ITag, TagType } from '@bike4mind/common';

const tagCreateSchema = z.object({
  name: z.string(),
  icon: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  type: z.enum(TagType),
});

type TagCreateParameters = z.infer<typeof tagCreateSchema>;

interface TagCreateAdapters {
  db: {
    fileTags: Pick<IFileTagRepository, 'create'>;
    // sessionTags: Pick<ISessionTagRepository, 'create'>;
  };
}

export const create = (userId: string, parameters: TagCreateParameters, adapters: TagCreateAdapters) => {
  const params = secureParameters(parameters, tagCreateSchema);
  const buildData = {
    userId,
    ...params,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ITag;

  switch (buildData.type) {
    case TagType.FILE:
      // Set Default values for file tag
      buildData.fileCount = 0;
      buildData.lastActivityAt = new Date();

      return adapters.db.fileTags.create(buildData);

    default:
      throw new Error('Tag Service: Create - Invalid tag type');
  }
};
