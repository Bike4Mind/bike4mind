/**
 * The single registry for every data-lake react-query key. The data-lake cache used to have
 * three modules (dataLakes.ts, dataLakeWizard.ts, fabFiles.ts) inventing keys for the same
 * endpoints as string literals; invalidations only cohere when every producer and consumer
 * names keys through here. Never write a data-lake query key as a literal outside this file
 * (tests asserting parity are the one exception).
 *
 * Key relationships (react-query prefix matching):
 * - `list` is a prefix of `public`/`archived`/`deleted`/`transitional`, so invalidating it
 *   refreshes those catalogs too.
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
  /** One lake's owner-facing access & membership view (GET /api/data-lakes/:id/access). */
  access: (dataLakeId: string) => ['data-lakes', 'access', dataLakeId] as const,
  /**
   * Who one lake's ownership may be transferred to (GET /api/data-lakes/:id/transfer-ownership).
   * Deliberately NOT nested under `access`: a completed transfer invalidates both, but the picker's
   * option set is fetched only while the transfer dialog is open and must not ride along on every
   * access-view refresh.
   */
  ownershipCandidates: (dataLakeId: string) => ['data-lakes', 'ownership-candidates', dataLakeId] as const,
  /** One page-set of the public-lake discovery catalog, per search term. */
  public: (search: string) => ['data-lakes', 'public', { search }] as const,
  archived: ['data-lakes', 'archived'] as const,
  deleted: ['data-lakes', 'deleted'] as const,
  /** Lakes stranded mid-lifecycle (GET /api/data-lakes/transitional) - the needs-attention list. */
  transitional: ['data-lakes', 'transitional'] as const,
  /** Batches still ingesting or in the background AI-tagging phase. */
  activeBatches: ['data-lake-batches', 'active'] as const,
  /** Query key for one lake's file list. `params` stays in the key for parity with the
   *  pre-registry shape (a trailing `undefined` hashes as null and must keep doing so), and it
   *  is what separates the full list from the Uncategorized-only slice of the same route - both
   *  stay under `filesOf`, so one tag write still invalidates both. */
  files: (dataLakeId: string | null, params?: { limit?: number; uncategorized?: boolean }) =>
    ['dataLakeFiles', dataLakeId, params] as const,
  /** Invalidation prefix covering every `files(id, ...)` variant of one lake. */
  filesOf: (dataLakeId: string) => ['dataLakeFiles', dataLakeId] as const,
  /** Invalidation prefix covering all lakes' file lists. */
  filesRoot: ['dataLakeFiles'] as const,
  /** One lake's derived health report (GET /api/data-lakes/:id/health), #1666. */
  health: (dataLakeId: string) => ['dataLakeHealth', dataLakeId] as const,
  /** Invalidation prefix covering every lake's health - used when a batch finishes ingesting, which
   *  is the moment a pending "indexing" badge should become measured (the message carries no lake id). */
  healthRoot: ['dataLakeHealth'] as const,
  /**
   * One lake's unanswered duplicate groups (GET /api/data-lakes/:id/membership-duplicates), #2238.
   * Kept out of the `health` key even though both report duplicates: this one is manage-gated and
   * ruling-aware, so a reader who may see `health` may get a 4xx here, and sharing a key would let
   * one surface's permission rejection blank the other.
   */
  membershipDuplicates: (dataLakeId: string) => ['dataLakeMembershipDuplicates', dataLakeId] as const,
  /** One lake's count of under-chunked files (GET /api/data-lakes/:id/rechunk) - the "Rebuild
   *  passages" badge, polled while a rebuild drains. */
  rebuildStatus: (dataLakeId: string) => ['dataLakeRebuildStatus', dataLakeId] as const,
  /** One lake's convergence plan (GET /api/data-lakes/:id/converge), #1681 - the preview an owner
   *  reads before confirming a wave. */
  convergencePlan: (dataLakeId: string) => ['dataLakeConvergencePlan', dataLakeId] as const,
  /** One lake's memory-profile state (GET /api/data-lakes/:id/lake-memory) - polled while
   *  a build is running. */
  lakeMemory: (dataLakeId: string) => ['dataLakeMemory', dataLakeId] as const,
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
  /**
   * One lake's config-change history (GET /api/data-lakes/:id/config-history), #1769. Outside the
   * `list` prefix for the same reason as `spend`: `list` is the invalidation prefix for renames and
   * visibility changes, and those are exactly the writes that ADD a history row - so keying history
   * under it would refetch the history of every lake on any lake edit. The one lake whose history a
   * config write does invalidate is invalidated explicitly, by this key.
   */
  configHistory: (dataLakeId: string | null, limit?: number) =>
    ['dataLakeConfigHistory', dataLakeId, { limit }] as const,
  /** Invalidation prefix covering every `limit` variant of ONE lake's history - what a config write
   *  invalidates, since a write adds a row to exactly one lake's history. */
  configHistoryOf: (dataLakeId: string) => ['dataLakeConfigHistory', dataLakeId] as const,
  /** Invalidation prefix covering every lake's config history. */
  configHistoryRoot: ['dataLakeConfigHistory'] as const,
  /**
   * One lake's acquisition review queue (GET /api/data-lakes/:id/proposals), #1671. Outside `list`
   * for the same reason as `spend`: `list` is the shared invalidation prefix for renames and
   * visibility changes, and the queue has nothing to do with those.
   */
  proposals: (dataLakeId: string | null, status?: string) => ['dataLakeProposals', dataLakeId, { status }] as const,
  /** Invalidation prefix covering every status variant of one lake's queue. */
  proposalsOf: (dataLakeId: string) => ['dataLakeProposals', dataLakeId] as const,
  /**
   * One lake's saved research configurations (GET /api/data-lakes/:id/research/configs), #1682.
   * Outside `list` for the same reason as `spend` and `proposals`.
   */
  researchConfigs: (dataLakeId: string | null) => ['dataLakeResearchConfigs', dataLakeId] as const,
  /**
   * One lake's research run history (GET /api/data-lakes/:id/research/runs). A SEPARATE root from
   * the configs, not a child: starting a run writes a run and touches a config's `lastRunAt`, but
   * the run list is polled while a run is in flight and the config list must not ride along on
   * every poll.
   */
  researchRuns: (dataLakeId: string | null, limit?: number) => ['dataLakeResearchRuns', dataLakeId, { limit }] as const,
  /** Invalidation prefix covering every `limit` variant of one lake's run history. */
  researchRunsOf: (dataLakeId: string) => ['dataLakeResearchRuns', dataLakeId] as const,
};
