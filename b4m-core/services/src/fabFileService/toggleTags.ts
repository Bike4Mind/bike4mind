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
  /**
   * Reconcile each file's post-toggle tag list against data-lake membership (see
   * dataLakeService `reconcileDataLakeFallbackTags`). Required, because this door can toggle a
   * lake meta-tag in EITHER direction: an absent reconciler would both skip the fallback on the
   * way in and strand one on the way out.
   */
  reconcileTags: (
    tags: { name: string; strength: number }[],
    previousTags: { name: string }[]
  ) => Promise<{ name: string; strength: number }[]>;
}

export const toggleTags = async (
  userId: string,
  params: FabFileToggleTagsParameters,
  { db, reconcileTags }: FabFileToggleTagsAdapters
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
      const previousTags = [...(f.tags ?? [])];

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

      // After the toggles, over the array about to be persisted: toggling a lake's meta-tag ON
      // stamps the lake's fallback, and toggling it OFF retracts the one the server stamped.
      // Only that one: a file carrying user-authored prefix tags stays a member of the lake after
      // its meta-tag goes, which is #1130's design - real removal is removeFileFromDataLake.
      f.tags = await reconcileTags(f.tags ?? [], previousTags);

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
