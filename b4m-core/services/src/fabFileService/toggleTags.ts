import { z } from 'zod';
import { IFabFileRepository, IFileTagRepository, IUserDocument } from '@bike4mind/common';

const fabFileToggleTagsSchema = z.object({
  ids: z.array(z.string()),
  tags: z.array(z.string()),
});

type FabFileToggleTagsParameters = z.infer<typeof fabFileToggleTagsSchema>;

interface FabFileToggleTagsAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'shareable' | 'update'>;
    fileTags: Pick<IFileTagRepository, 'incrementFileCountBy'>;
    users: { findById: (id: string) => Promise<IUserDocument | null> };
  };
}

export const toggleTags = async (
  userId: string,
  params: FabFileToggleTagsParameters,
  { db }: FabFileToggleTagsAdapters
) => {
  const { ids, tags } = fabFileToggleTagsSchema.parse(params);

  // Get user for permission checks
  const user = await db.users.findById(userId);
  if (!user) throw new Error('User not found');

  // Only get files that the user has update access to
  const fabFiles = await db.fabFiles.shareable.findAllAccessibleByIds(user, ids);

  // Check if user has permission to update all requested files
  if (fabFiles.length !== ids.length) {
    throw new Error('Some files are not accessible or you do not have permission to edit them');
  }

  const tagCounters: Record<string, number> = {};

  const updatedFabFiles = await Promise.all(
    fabFiles.map(async f => {
      tags.forEach(tag => {
        tagCounters[tag] ||= 0;

        if (f.tags?.some(t => t.name.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
          f.tags = f.tags.filter(t => t.name.toLocaleLowerCase() !== tag.toLocaleLowerCase());
          tagCounters[tag] -= 1;
        } else {
          f.tags?.push({ name: tag.toLocaleLowerCase(), strength: 0 });
          tagCounters[tag] += 1;
        }
      });

      await db.fabFiles.update(f);
      return f;
    })
  );

  await Promise.all(
    tags.map(async tag => {
      await db.fileTags.incrementFileCountBy({ name: tag, userId }, tagCounters[tag]);
    })
  );

  return updatedFabFiles;
};
