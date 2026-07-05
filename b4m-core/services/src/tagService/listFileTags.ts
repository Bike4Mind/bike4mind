import { IFileTagRepository } from '@bike4mind/common';

interface TagListFileTagsAdapters {
  db: {
    fileTags: Pick<IFileTagRepository, 'findAllByUserId'>;
  };
}

export const listFileTags = async (userId: string, adapters: TagListFileTagsAdapters) => {
  const { db } = adapters;

  const fileTags = await db.fileTags.findAllByUserId(userId);

  return fileTags;
};
