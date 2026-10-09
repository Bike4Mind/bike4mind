import type { TagPathCount } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';

/** A lake, reduced to what scoping needs. */
export interface TagScopeLake {
  fileTagPrefix: string;
}

/**
 * The lake's root path in the tag tree: its prefix minus the trailing colon (`acme:legal:` gives
 * `acme:legal`, matching buildTagTree's colon-split). Empty for a lake with no usable prefix -
 * reachable only through malformed/legacy data, since a real lake's `fileTagPrefix` is validated
 * non-empty at create time.
 */
export const lakeRootTag = (lake: TagScopeLake): string =>
  typeof lake.fileTagPrefix === 'string' ? lake.fileTagPrefix.replace(/:+$/, '') : '';

/**
 * Narrows the browse surface's tag counts to the selected lakes, which is what makes the surface's
 * lake selection scope the taxonomy tree (#1645, widened to a set in #3042).
 *
 * NOT the boundary: with a selection, the Explorer reads `/api/data-lakes/tag-counts?lakeId=...`,
 * which the server already counts over the selected lakes' membership. This prefix filter is a
 * belt over that result. An EMPTY selection is the all-lakes scope and returns the list untouched;
 * it is the picker's "All data lakes" row, not an absence of choice.
 *
 * Why prefix containment cannot be the boundary: overlapping prefixes are refused at create time
 * only WITHIN one creator or org (see `tagPrefixIssue` in `@bike4mind/common`). Two creators may
 * deliberately use the same prefix, and a viewer who reaches both lakes (an admin) would see both
 * lakes' tags under either one if this ran over the unscoped, prefix-merged payload.
 */
export function scopeTagCountsToLakes(tagCounts: TagPathCount[], lakes: TagScopeLake[]): TagPathCount[] {
  if (lakes.length === 0) return tagCounts;
  // A tag matching two selected lakes must still appear ONCE: filter the counts by "any selected
  // prefix" rather than concatenating a per-lake pass, which would duplicate the branch in the
  // tree and double its count.
  // Also keep the lake-root row: its distinct fileCount covers the lake's tagged files, where
  // buildTagTree's fallback would sum the children. Rows above it mix in other lakes, so they still
  // drop out. A root row with files of its OWN came from another lake whose prefix is the root
  // (`acme:` vs `acme:legal:`), so it keeps only the path and the tree sums the children instead.
  const roots = new Set(lakes.map(lakeRootTag).filter(Boolean));
  const scoped: TagPathCount[] = [];
  for (const tc of tagCounts) {
    if (lakes.some(lake => tc.tag.startsWith(lake.fileTagPrefix))) scoped.push(tc);
    else if (roots.has(tc.tag)) scoped.push(tc.count === 0 ? tc : { tag: tc.tag, count: 0 });
  }
  return scoped;
}

/**
 * Adds a zero-count entry for every lake with no tagged files, so buildTagTree gives it a root
 * node instead of omitting it entirely - a tree built purely from tag counts has nothing to seed
 * a branch from otherwise (#3234).
 *
 * The seed tag is the prefix itself (trailing colon stripped, matching buildTagTree's own
 * colon-split), so a nested prefix like "acme:legal:" seeds "acme:legal" rather than a bare
 * "acme" that would misfile under a sibling lake sharing that first segment.
 *
 * Guards a lake with no usable prefix (empty string, or the field missing entirely) rather than
 * trusting the type - reachable only through malformed/legacy data, since a real lake's
 * `fileTagPrefix` is validated non-empty at create time.
 */
export function seedEmptyLakeTags(tagCounts: TagPathCount[], lakes: TagScopeLake[]): TagPathCount[] {
  const seeded: TagPathCount[] = [];
  for (const lake of lakes) {
    const prefix = lakeRootTag(lake);
    if (!prefix) continue;
    const hasContent = tagCounts.some(tc => tc.tag === prefix || tc.tag.startsWith(`${prefix}:`));
    if (!hasContent) seeded.push({ tag: prefix, count: 0 });
  }
  return seeded.length > 0 ? [...tagCounts, ...seeded] : tagCounts;
}
