/** A lake, reduced to what scoping needs. */
export interface TagScopeLake {
  fileTagPrefix: string;
}

export type TagCount = { tag: string; count: number };

/**
 * Narrows the browse surface's tag counts to the selected lakes, which is what makes the surface's
 * lake selection scope the taxonomy tree (#1645, widened to a set in #3042).
 *
 * This is a client-side filter on the SAME `/api/data-lakes/tag-counts` payload the unscoped tree
 * already reads - every taxonomy tag in a lake is namespaced under that lake's `fileTagPrefix` - so
 * changing the selection costs no request. An EMPTY selection is the all-lakes scope and returns
 * the list untouched; it is the picker's "All data lakes" row, not an absence of choice.
 *
 * KNOWN ASSUMPTION: prefix containment is the membership test, so a lake whose prefix is a prefix OF
 * ANOTHER lake's (`research:` vs `research:deep:`) would absorb that lake's tags into its scope.
 * Overlapping prefixes are refused at create time for exactly this reason (see `tagPrefixIssue` in
 * `@bike4mind/common`, which blocks an overlapping prefix with "They would share files"), so this
 * cannot arise for a lake created through the wizard. A legacy lake predating that rule could still
 * overlap; the scope would over-include rather than leak across a tenant boundary, because the
 * counts payload is already access-filtered server-side before it reaches here.
 */
export function scopeTagCountsToLakes(tagCounts: TagCount[], lakes: TagScopeLake[]): TagCount[] {
  if (lakes.length === 0) return tagCounts;
  // A tag matching two selected lakes must still appear ONCE: filter the counts by "any selected
  // prefix" rather than concatenating a per-lake pass, which would duplicate the branch in the
  // tree and double its count.
  return tagCounts.filter(tc => lakes.some(lake => tc.tag.startsWith(lake.fileTagPrefix)));
}
