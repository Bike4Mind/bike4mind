import { IFileTag, IFileTagRepository, TagType } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const tagCreateFileTagSchema = z.object({
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
});

type TagCreateFileTagSchema = z.infer<typeof tagCreateFileTagSchema>;

interface TagCreateFileTagAdapters {
  db: {
    fileTags: Pick<IFileTagRepository, 'create'>;
  };
}

export const createFileTag = async (
  userId: string,
  parameters: TagCreateFileTagSchema,
  adapters: TagCreateFileTagAdapters
) => {
  const { name, icon, color, description } = secureParameters(parameters, tagCreateFileTagSchema);

  const build: Omit<IFileTag, 'id'> = {
    name,
    icon,
    color,
    description,
    userId,

    type: TagType.FILE,

    fileCount: 0,
    lastActivityAt: new Date(),

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const tag = await adapters.db.fileTags.create(build);

  return tag;
};
