/**
 * The single registry for every data-lake react-query key. The data-lake cache used to have
 * three modules (dataLakes.ts, dataLakeWizard.ts, fabFiles.ts) inventing keys for the same
 * endpoints as string literals; invalidations only cohere when every producer and consumer
 * names keys through here. Never write a data-lake query key as a literal outside this file
 * (tests asserting parity are the one exception).
 *
 * Key relationships (react-query prefix matching):
 * - `list` is a prefix of `public`/`archived`/`deleted`, so invalidating it refreshes those
 *   catalogs too.
 * - `filesRoot`/`tagCountsRoot`/`articlesRoot` are bare prefixes: files are keyed by lake id
 *   + params, tag-counts/articles by a browse-source discriminator ('opti' | 'datalakes').
 *   Invalidate the root so every variant refreshes; a fully-specified key would refresh only
 *   one surface.
 */
export const dataLakeKeys = {
  /** The lake list (GET /api/data-lakes). */
  list: ['data-lakes'] as const,
  /** One page-set of the public-lake discovery catalog, per search term. */
  public: (search: string) => ['data-lakes', 'public', { search }] as const,
  archived: ['data-lakes', 'archived'] as const,
  deleted: ['data-lakes', 'deleted'] as const,
  /** Batches still ingesting or in the background AI-tagging phase. */
  activeBatches: ['data-lake-batches', 'active'] as const,
  /** Query key for one lake's file list. `params` stays in the key for parity with the
   *  pre-registry shape (a trailing `undefined` hashes as null and must keep doing so). */
  files: (dataLakeId: string | null, params?: { limit?: number }) => ['dataLakeFiles', dataLakeId, params] as const,
  /** Invalidation prefix covering every `files(id, ...)` variant of one lake. */
  filesOf: (dataLakeId: string) => ['dataLakeFiles', dataLakeId] as const,
  /** Invalidation prefix covering all lakes' file lists. */
  filesRoot: ['dataLakeFiles'] as const,
  tagCounts: (source: string) => ['dataLakeTagCounts', source] as const,
  tagCountsRoot: ['dataLakeTagCounts'] as const,
  articles: (source: string, params?: unknown) => ['dataLakeArticles', source, params] as const,
  articlesRoot: ['dataLakeArticles'] as const,
};
