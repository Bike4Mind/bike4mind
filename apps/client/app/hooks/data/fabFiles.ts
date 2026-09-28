/**
 * Public barrel for the fab-file hooks. Implementation lives in fabFileQueries.ts /
 * fabFileSearch.ts / fabFileMutations.ts (keys in fabFileKeys.ts); this path stays the
 * canonical import for app code and is pinned by the premium overlay, so it must keep
 * exporting everything the pre-split module exported.
 */
export * from './fabFileQueries';
export * from './fabFileSearch';
export * from './fabFileMutations';

// The premium overlay imports this hook from the fabFiles path (pinned ref). Keep the alias
// until the overlay repoints its imports, then delete it. New code imports from dataLakes.
// The type aliases cost nothing at runtime (erased) and cover downstream declarations typed
// against the pre-move fabFiles surface.
export { useDataLakeArticleCounts } from './dataLakes';
export type { DataLakeArticlesParams, DataLakeTagCountsResponse, DataLakeBrowseSource } from './dataLakes';
