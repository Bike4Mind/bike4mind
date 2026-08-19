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
// Type-only: keeps this module runtime-free (no cycle with dataLakes.ts, which value-imports us).
import type { DataLakeArticlesParams, DataLakeBrowseSource } from '@client/app/hooks/data/dataLakes';

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
  /** One lake's derived health report (GET /api/data-lakes/:id/health), #1666. */
  health: (dataLakeId: string) => ['dataLakeHealth', dataLakeId] as const,
  /** Invalidation prefix covering every lake's health - used when a batch finishes ingesting, which
   *  is the moment a pending "indexing" badge should become measured (the message carries no lake id). */
  healthRoot: ['dataLakeHealth'] as const,
  /** One lake's count of under-chunked files (GET /api/data-lakes/:id/rechunk) - the "Rebuild
   *  passages" badge, polled while a rebuild drains. */
  rebuildStatus: (dataLakeId: string) => ['dataLakeRebuildStatus', dataLakeId] as const,
  /** One lake's convergence plan (GET /api/data-lakes/:id/converge), #1681 - the preview an owner
   *  reads before confirming a wave. */
  convergencePlan: (dataLakeId: string) => ['dataLakeConvergencePlan', dataLakeId] as const,
  tagCounts: (source: DataLakeBrowseSource) => ['dataLakeTagCounts', source] as const,
  tagCountsRoot: ['dataLakeTagCounts'] as const,
  articles: (source: DataLakeBrowseSource, params?: DataLakeArticlesParams) =>
    ['dataLakeArticles', source, params] as const,
  articlesRoot: ['dataLakeArticles'] as const,
  /**
   * One lake's spend view (GET /api/data-lakes/:id/spend). Deliberately NOT nested under
   * `list` - `list` is a shared invalidation prefix for renames/visibility changes, and keying
   * spend under it would refetch spend on every unrelated lake mutation.
   */
  spend: (dataLakeId: string | null, days: number) => ['dataLakeSpend', dataLakeId, { days }] as const,
};
