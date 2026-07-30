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

  // Attribute each aggregate bucket to a tag document. An exact name match wins. A bucket that no
  // document claims exactly is matched case-insensitively, because fabFileService/toggleTags
  // lowercases what it writes onto files while tagService/create keeps whatever casing the tag
  // document was created with - without the fallback, an `Invoices` document over `invoices` files
  // would read zero.
  //
  // The fold cannot be unconditional: TagSchema's unique index is { userId, name } with no
  // collation, so `Invoices` and `invoices` are two legitimate documents, and crediting both with
  // the combined total would count the same file twice. An unclaimed bucket is therefore only
  // credited when exactly one document folds to its name; when several do it is unattributable and
  // dropped, which under-reports rather than inventing files. toLowerCase and not
  // toLocaleLowerCase, whose dotless-i mapping varies by runtime locale.
  const exactNames = new Set(fileTags.map(t => t.name));
  const documentsPerFoldedName = new Map<string, number>();
  for (const { name } of fileTags) {
    const key = name.toLowerCase();
    documentsPerFoldedName.set(key, (documentsPerFoldedName.get(key) ?? 0) + 1);
  }

  const exactCounts = new Map<string, number>();
  const unclaimedCounts = new Map<string, number>();
  for (const { tag, count } of tagCounts) {
    if (exactNames.has(tag)) {
      exactCounts.set(tag, count);
    } else {
      const key = tag.toLowerCase();
      unclaimedCounts.set(key, (unclaimedCounts.get(key) ?? 0) + count);
    }
  }

  return fileTags.map(tag => {
    const folded = tag.name.toLowerCase();
    const unclaimed = documentsPerFoldedName.get(folded) === 1 ? (unclaimedCounts.get(folded) ?? 0) : 0;
    return { ...tag, fileCount: (exactCounts.get(tag.name) ?? 0) + unclaimed };
  });
};
