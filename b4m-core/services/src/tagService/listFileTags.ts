import { IFabFileRepository, IFileTagRepository } from '@bike4mind/common';

interface TagListFileTagsParams {
  userGroups: string[];
  dataLakeTags: string[];
}

interface TagListFileTagsAdapters {
  db: {
    fileTags: Pick<IFileTagRepository, 'findAllByUserId'>;
    fabFiles: Pick<IFabFileRepository, 'countFilesByTagForUser'>;
  };
}

/**
 * Lists a user's file tags with `fileCount` recomputed from live `FabFile.tags` rather than read
 * off the tag document. The stored counter is only maintained by fabFileService/toggleTags and the
 * file-delete routes, so every other writer (the `$pull` removal path, a whole-array tags replace
 * on PUT /api/files/[id], tags set at creation) leaves it permanently drifted.
 *
 * Uses the same aggregate and the same options as GET /api/files/tags/counts, which backs the tag
 * tree - the two surfaces must stay in sync or the sidebar badge and the tag card disagree for the
 * same tag. Counting live files means soft-deleted files drop out, as does anything attached to a
 * session (the aggregate's own filter).
 */
export const listFileTags = async (
  userId: string,
  params: TagListFileTagsParams,
  adapters: TagListFileTagsAdapters
) => {
  const { db } = adapters;

  const [fileTags, tagCounts] = await Promise.all([
    db.fileTags.findAllByUserId(userId),
    db.fabFiles.countFilesByTagForUser(userId, {
      userGroups: params.userGroups,
      dataLakeTags: params.dataLakeTags,
    }),
  ]);

  // The aggregate groups on the exact stored `tags.name`, so one tag document can match several
  // buckets differing only in case; sum them instead of letting the last one win. toLowerCase and
  // not toLocaleLowerCase, whose dotless-i mapping varies by runtime locale.
  const countsByName = new Map<string, number>();
  for (const { tag, count } of tagCounts) {
    const key = tag.toLowerCase();
    countsByName.set(key, (countsByName.get(key) ?? 0) + count);
  }

  return fileTags.map(tag => ({ ...tag, fileCount: countsByName.get(tag.name.toLowerCase()) ?? 0 }));
};
