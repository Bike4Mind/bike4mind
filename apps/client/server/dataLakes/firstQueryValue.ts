/**
 * Express hands back `string[]` for a repeated query param (`?search=a&search=b`), but a route's
 * query type usually only promises `string`. Narrow to the first value rather than let an array
 * reach downstream code that assumes a single string - `fabFilesService.search`'s `textSearch`,
 * or `record()`'s `queryText.trim()` in the access-audit write, which would throw on an array and
 * (since `recordLakeAccessEvent` never rethrows) silently drop the whole event instead of just
 * the search text.
 */
export function firstQueryValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}
