/**
 * One tag-tree path row. `count` is files tagged with exactly `tag`; `fileCount` is distinct files
 * tagged with `tag` or anything under it.
 */
export interface TagPathFileCount {
  tag: string;
  count: number;
  fileCount: number;
}

/** `a:b:c` gives `['a', 'a:b', 'a:b:c']`, splitting on `:` exactly as the client's buildTagTree does. */
export const tagSelfAndAncestorPaths = (tag: string): string[] => {
  const segments = tag.split(':');
  return segments.map((_, i) => segments.slice(0, i + 1).join(':'));
};

/**
 * Rows for every path under a set of files, each file counted once per path however many of its
 * tags sit under that path. Input is grouped: `files` files share the exact tag list `tags`, which
 * is how `countDataLakeTagsByPrefix` (`@bike4mind/database`) hands back its aggregate. The ONE
 * implementation of the path rules for the server counter and the client's Manager trees, so the
 * two cannot drift apart.
 */
export function countTagPathsByTagSet(
  groups: ReadonlyArray<{ tags: readonly string[]; files: number }>
): TagPathFileCount[] {
  const rows = new Map<string, TagPathFileCount>();
  const rowFor = (tag: string) => {
    let row = rows.get(tag);
    if (!row) {
      row = { tag, count: 0, fileCount: 0 };
      rows.set(tag, row);
    }
    return row;
  };
  for (const { tags, files } of groups) {
    const own = new Set(tags);
    const paths = new Set<string>();
    for (const tag of own) for (const path of tagSelfAndAncestorPaths(tag)) paths.add(path);
    for (const path of paths) rowFor(path).fileCount += files;
    for (const tag of own) rowFor(tag).count += files;
  }
  return Array.from(rows.values());
}

/** countTagPathsByTagSet for one tag list per file. */
export const countTagPaths = (tagLists: ReadonlyArray<readonly string[]>): TagPathFileCount[] =>
  countTagPathsByTagSet(tagLists.map(tags => ({ tags, files: 1 })));
