import { IFabFileRepository, IFileTagRepository, IFileTagWithFileCount } from '@bike4mind/common';
import { matchTagDocument } from './tagName';

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
 * Lists a user's file tags, computing `fileCount` from live `FabFile.tags` on every read. The tag
 * document stores no count of its own: a stored counter has to be maintained by every writer that
 * touches a file's tags, and several never did (the `$pull` removal path, a whole-array tags replace
 * on PUT /api/files/[id], tags set at creation), so it drifted permanently. This is the only place
 * a `fileCount` comes from, which is why the return type is `IFileTagWithFileCount` and a tag read
 * through any other repository method has none.
 *
 * Uses the same aggregate and the same options as GET /api/files/tags/counts, which backs the tag
 * tree - the two surfaces must stay in sync or the sidebar badge and the tag card disagree for the
 * same tag. Counting live files means soft-deleted files drop out, as does anything attached to a
 * session (the aggregate's own filter).
 *
 * Same aggregate, different grouping, though: this folds each bucket onto a tag document
 * (matchTagDocument, case-insensitive) while the tree renders the raw `tags.name` buckets. So on
 * files that store more than one casing of a name - which a rename leaves behind, since
 * updateTagsByUserId only rewrites the name it was given - this reports one correct row and the tree
 * shows one row per casing. The divergence is the tree's grouping, not this count.
 */
export const listFileTags = async (
  userId: string,
  params: TagListFileTagsParams,
  adapters: TagListFileTagsAdapters
): Promise<IFileTagWithFileCount[]> => {
  const { db } = adapters;

  const [fileTags, tagCounts] = await Promise.all([
    db.fileTags.findAllByUserId(userId),
    db.fabFiles.countFilesByTagForUser(userId, {
      userGroups: params.userGroups,
      dataLakeTags: params.dataLakeTags,
    }),
  ]);

  // Attribute each aggregate bucket to a tag document under the shared collision rule
  // (matchTagDocument): the exact name wins, and a bucket no document claims exactly is credited to
  // a case-folded match only when exactly ONE document folds to it. Both halves are load-bearing.
  // The fold is needed because files can store a casing no document uses, so an `Invoices` document
  // over `invoices` files would otherwise read zero. It cannot be unconditional because TagSchema's
  // unique index has no collation, so `Invoices` and `invoices` are two legitimate documents and
  // crediting both with the combined total would count the same file twice; an ambiguous bucket is
  // dropped instead, which under-reports rather than inventing files.
  const countsPerDocument = new Map<string, number>();
  for (const { tag, count } of tagCounts) {
    const doc = matchTagDocument(tag, fileTags);
    if (!doc) continue;
    countsPerDocument.set(doc.id, (countsPerDocument.get(doc.id) ?? 0) + count);
  }

  return fileTags.map(tag => ({ ...tag, fileCount: countsPerDocument.get(tag.id) ?? 0 }));
};
