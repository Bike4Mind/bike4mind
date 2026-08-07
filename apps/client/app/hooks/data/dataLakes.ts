import type {
  BrowsePublicDataLakesResult,
  DataLakeConfig,
  IDataLakeBatchDocument,
  IDataLakeBatchSummary,
  IFabFileDocument,
  ManageableDataLakeConfig,
  TaxonomyTag,
} from '@bike4mind/common';
import { DATA_LAKES, normalizeTagPrefix, tagPrefixesOverlap } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType, UpdateDataLakeRequestInputType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { invalidateGearsStatusWhileLocked } from '@client/app/hooks/useGearsStatus';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';

/**
 * The active account-switcher org to scope a data-lake write to, or undefined for the
 * Personal context. Read from the store at mutation time (not via the hook) so it can't go
 * stale between render and submit. The server authorization-validates it before trusting it.
 * Exported so the wizard's create path shares the one derivation instead of re-deriving it.
 */
export function activeOrgId(): string | undefined {
  const { selectedAccount } = useSelectedAccount.getState();
  return selectedAccount && !selectedAccount.personal ? selectedAccount.id : undefined;
}

// ── Lake catalog & lifecycle ────────────────────────────────────────────────

/**
 * Fetches all data lakes accessible to the current user. Manage-gated shape: the server attaches
 * the editor-only fields (systemPrompt) per lake, and only where `canManage` holds - so a lake the
 * caller can merely read arrives without them.
 *
 * Data lakes are an admin-gated feature (EnableDataLakes, default off); the endpoint 403s when
 * disabled. Callers that mount app-wide (e.g. a closed modal) pass `enabled: false` until the
 * list is actually needed, and the gate rejection is never retried, so a disabled feature can't
 * spam a 403 on every page.
 *
 * The defaults (no retry, 2 min staleTime, no focus refetch) are tuned for those display
 * surfaces. A consumer whose correctness depends on the CURRENT list - a gate, not a hint -
 * overrides them via `opts` (see useDuplicatePrefixLake); staleTime is per-observer and retry
 * follows the observer that triggers the fetch, so one eager consumer doesn't change the others.
 */
export function useGetDataLakes(
  enabled = true,
  opts?: { staleTime?: number; retry?: number | boolean; refetchOnWindowFocus?: boolean }
) {
  return useQuery({
    queryKey: dataLakeKeys.list,
    enabled,
    retry: opts?.retry ?? false,
    queryFn: async () => {
      const response = await api.get<{ data: ManageableDataLakeConfig[] }>('/api/data-lakes');
      return response.data.data;
    },
    refetchOnWindowFocus: opts?.refetchOnWindowFocus ?? false,
    staleTime: opts?.staleTime ?? 1000 * 60 * 2,
  });
}

/**
 * The data lake in the current create scope whose `fileTagPrefix` would overlap `prefix`, if any.
 *
 * Two lakes sharing a prefix share their prefix-tagged files, so permanently deleting one would
 * take files the other holds. The server refuses such a create; this is the form-level mirror so
 * the wizard blocks before submit. Best-effort only - the lake list cannot show an org peer's
 * gated lake, so the server stays the authority.
 *
 * Overlap is bidirectional: `docs:` matches a `docs:legal:foo` tag, so `docs:` and `docs:legal:`
 * conflict either way round.
 */
export function useDuplicatePrefixLake(prefix: string, skip = false): DataLakeConfig | undefined {
  // This mirrors a server refusal and gates the wizard's Next/Upload buttons, so it must see
  // the current list and ride out transient errors - the list-surface defaults (2 min stale,
  // no retry, no focus refetch) would let a stale or errored read open the gate.
  const { data: allLakes } = useGetDataLakes(true, { staleTime: 0, retry: 3, refetchOnWindowFocus: true });
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const scopeOrgId = selectedAccount && !selectedAccount.personal ? selectedAccount.id : undefined;

  if (skip || !normalizeTagPrefix(prefix)) return undefined;

  return allLakes?.find(
    // Same scope as the server guard: same org, or - in the Personal context - the lakes this
    // list shows the user, which are the ones they could collide with.
    lake => (lake.organizationId || undefined) === scopeOrgId && tagPrefixesOverlap(prefix, lake.fileTagPrefix)
  );
}

/**
 * Creates a new data lake configuration.
 */
export function useCreateDataLake(options?: { onSuccess?: (data: DataLakeConfig) => void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateDataLakeRequestInputType) => {
      // An explicit organizationId on params wins; otherwise fall back to the active switcher org.
      const organizationId = params.organizationId ?? activeOrgId();
      const response = await api.post<DataLakeConfig>('/api/data-lakes', {
        ...params,
        ...(organizationId ? { organizationId } : {}),
      });
      return response.data;
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      // Reveal the 'datalakes' nav slot immediately rather than after the
      // gears/status staleTime elapses (#833).
      invalidateGearsStatusWhileLocked(queryClient, ['datalakes']);
      toast.success(`Data lake "${data.name}" created`);
      options?.onSuccess?.(data);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to create data lake');
    },
  });
}

/**
 * Updates an existing data lake configuration.
 */
export function useUpdateDataLake() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...params }: UpdateDataLakeRequestInputType & { id: string }) => {
      const response = await api.put<DataLakeConfig>(`/api/data-lakes/${id}`, params);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      toast.success('Data lake updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update data lake');
    },
  });
}

export type LakeVisibilityChoice = 'private' | 'organization' | 'public';

const VISIBILITY_TOAST: Record<LakeVisibilityChoice, string> = {
  organization: 'Data lake shared to your organization',
  public: 'Data lake published — readable by everyone',
  private: 'Data lake set to private',
};

/**
 * Sets a data lake's visibility: 'private' (owner-only), 'organization' (shared to the caller's
 * active org), or 'public' (readable app-wide). Only the org path needs a target org; the server
 * authorization-validates it against the caller's memberships before scoping. Publishing a gated
 * lake is refused server-side.
 */
export function useSetLakeVisibility() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, visibility }: { id: string; visibility: LakeVisibilityChoice }) => {
      // Only an org promotion needs a target org; private/public are org-less, so don't send it
      // (avoids a needless membership round-trip and a spurious 403 if the caller just left the org).
      const organizationId = visibility === 'organization' ? activeOrgId() : undefined;
      const response = await api.post<DataLakeConfig>(`/api/data-lakes/${id}/visibility`, {
        visibility,
        ...(organizationId ? { organizationId } : {}),
      });
      return response.data;
    },
    onSuccess: (_data, { visibility }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      toast.success(VISIBILITY_TOAST[visibility]);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to change visibility');
    },
  });
}

/** One page of the public-lake discovery catalog. Fixed so `limit` always stays <= the API cap. */
export const PUBLIC_LAKES_PAGE_SIZE = 24;

/**
 * Browse the public-lake discovery catalog: gate-less public lakes across all orgs, with
 * search + load-more. `search` should already be debounced by the caller. Uses offset paging
 * with a FIXED page size (not a growing `limit`) so a deep load-more can never exceed the
 * route's max-limit cap; pages accumulate via useInfiniteQuery. A new `search` is a new query
 * key, so it resets to the first page automatically.
 */
export function useBrowsePublicDataLakes(search: string) {
  return useInfiniteQuery({
    queryKey: dataLakeKeys.public(search),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      params.set('limit', String(PUBLIC_LAKES_PAGE_SIZE));
      params.set('offset', String(pageParam));
      const response = await api.get<BrowsePublicDataLakesResult>(`/api/data-lakes/public?${params.toString()}`);
      return response.data;
    },
    // Next offset = how many we've loaded so far; undefined once we've reached the total.
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, page) => n + page.data.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    // Keep prior pages visible while a new search query resolves (no flash to empty).
    placeholderData: keepPreviousData,
  });
}

type LifecycleAction = 'archive' | 'unarchive' | 'restore' | 'delete' | 'cleanup';

function useLifecycleMutation(action: LifecycleAction, successMessage: string, errorMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/api/data-lakes/${id}/lifecycle`, { action });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.archived });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.deleted });
      toast.success(successMessage);
    },
    onError: (error: Error) => {
      toast.error(error.message || errorMessage);
    },
  });
}

/** Archives (reversible) a data lake: cancels in-flight batches, soft-hides files. Invalidates all three lists. */
export function useArchiveDataLake() {
  return useLifecycleMutation('archive', 'Data lake archived', 'Failed to archive data lake');
}

/** Restores an archived data lake (with dedup pass). */
export function useUnarchiveDataLake() {
  return useLifecycleMutation('unarchive', 'Data lake restored', 'Failed to restore data lake');
}

/** Recovers a soft-deleted (phase-1) data lake back to active (with dedup pass). */
export function useRestoreDeletedDataLake() {
  return useLifecycleMutation('restore', 'Data lake restored', 'Failed to restore data lake');
}

/** Phase 1 of permanent delete: soft-delete (recoverable). */
export function usePermanentDeleteDataLake() {
  return useLifecycleMutation('delete', 'Data lake deleted (recoverable)', 'Failed to delete data lake');
}

/** Phase 2 of permanent delete: irreversible hard-delete sweep. */
export function useCleanupDataLake() {
  return useLifecycleMutation('cleanup', 'Data lake permanently purged', 'Failed to clean up data lake');
}

/** Lists archived data lakes (management view). */
export function useGetArchivedDataLakes(enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.archived,
    enabled,
    queryFn: async () => {
      const response = await api.get<{ data: DataLakeConfig[] }>('/api/data-lakes/archived');
      return response.data.data;
    },
  });
}

/** Lists soft-deleted data lakes (management view: restore / purge). */
export function useGetDeletedDataLakes(enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.deleted,
    enabled,
    queryFn: async () => {
      const response = await api.get<{ data: DataLakeConfig[] }>('/api/data-lakes/deleted');
      return response.data.data;
    },
  });
}

// ── Batch progress / background AI tagging ──────────────────────────────────

/** Polling cadence for the list's ingest/AI-tagging badges - no per-batch WebSocket wiring
 * needed for a list view; a short poll is simple and good enough for background progress. */
const ACTIVE_BATCHES_POLL_MS = 10_000;

/**
 * Batches the Data Lakes list needs to show a badge for: still uploading/chunking/
 * vectorizing, OR the background AI-tagging phase is running/ready/failed. These are
 * independent clocks (a batch can be fully 'completed' while 'analyzing'), reconciled
 * server-side on every call - see GET /api/data-lakes/batches.
 */
export function useActiveDataLakeBatches(enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.activeBatches,
    enabled,
    queryFn: async () => {
      const response = await api.get<{ data: IDataLakeBatchSummary[] }>('/api/data-lakes/batches');
      return response.data.data;
    },
    refetchInterval: enabled ? ACTIVE_BATCHES_POLL_MS : false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Applies the reviewed/edited AI tag suggestions to every matching file in a batch.
 * `tags` is the review panel's full edited list (including any the reviewer deleted - the
 * server filters those out, mirroring the shape the old wizard step's TagCard produced).
 */
export function useApplyTaxonomySuggestions(batchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tags: TaxonomyTag[]) => {
      const res = await api.post<{ success: true; filesUpdated: number }>(
        `/api/data-lakes/batches/${batchId}/apply-taxonomy`,
        { tags }
      );
      return res.data;
    },
    onSuccess: result => {
      toast.success(
        `Tags applied to ${result.filesUpdated.toLocaleString()} file${result.filesUpdated === 1 ? '' : 's'}`
      );
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.activeBatches });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesRoot });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to apply tag suggestions');
    },
  });
}

/** Manually re-runs AI tag inference for an already-analyzed (or failed) batch. */
export function useReanalyzeTaxonomy(batchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (context?: string) => {
      const res = await api.post<IDataLakeBatchDocument>(`/api/data-lakes/batches/${batchId}/reanalyze-taxonomy`, {
        context,
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.activeBatches });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to re-analyze tags');
    },
  });
}

/**
 * Clears a ready/failed taxonomy batch's attention chip without applying or re-analyzing it.
 * No file/tag data changes - only invalidates the active-batches list (unlike apply, which also
 * invalidates file/tag-count queries since it actually writes tags).
 */
export function useDismissTaxonomy(batchId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ success: true }>(`/api/data-lakes/batches/${batchId}/dismiss-taxonomy`, {});
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.activeBatches });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to dismiss tag suggestions');
    },
  });
}

// ── Per-lake files ──────────────────────────────────────────────────────────

/**
 * Hook: Fetch files belonging to a specific data lake by ID.
 * One lake's own file list (GET /api/data-lakes/{id}/articles) - not the cross-lake browse
 * query; see useGetDataLakeArticles.
 */
export function useDataLakeFiles(dataLakeId: string | null, params?: { limit?: number }) {
  return useQuery({
    queryKey: dataLakeKeys.files(dataLakeId, params),
    queryFn: async () => {
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        `/api/data-lakes/${dataLakeId}/articles`,
        { params: { limit: params?.limit ?? 100 } }
      );
      return response.data;
    },
    enabled: !!dataLakeId,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Hook: Re-run chunking + vectorization for a single fabFile in a data lake.
 * Useful for files that landed with 0 chunks (failed/partial extraction).
 */
export function useReprocessFabFile(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.post<{ messageId: string }>('/api/files/reprocess', { fabFileId });
      return res.data;
    },
    onSuccess: () => {
      toast.success('Re-processing started - chunking and vectorization will re-run.');
      if (dataLakeId) queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to re-process file');
    },
  });
}

/**
 * Hook: Remove a single file from a data lake. Drops the lake's membership tags from the file
 * and leaves the file itself alone - no soft-delete, no chunk teardown. Owner/admin only; the
 * server verifies the file actually belongs to the lake.
 */
export function useRemoveFileFromDataLake(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.delete<{ success: true; fileCount: number; totalSizeBytes: number }>(
        `/api/data-lakes/${dataLakeId}/files/${fabFileId}`
      );
      return res.data;
    },
    onSuccess: () => {
      toast.success('File removed from data lake.');
      if (dataLakeId) queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
      // Refresh the lake list to pick up the recomputed stats. fileCount counts meta-tagged
      // files only, so removing a file that was in the lake by prefix alone drops a row from
      // the list without moving the count.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      // Removal also drops the file's tags under the lake's prefix, so every tag-derived view
      // is stale (incl. the manager's count-chip fallback). Root prefixes: these caches are
      // keyed by an opti/datalakes source discriminator, and a fully-specified key would
      // refresh only one surface.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.articlesRoot });
      // Bare prefix: the tag list carries a fileCount derived from the files that hold each tag,
      // so dropping tags here staled the list too, not only the counts endpoint.
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to remove file from data lake');
    },
  });
}

// ── Browse surfaces (tag tree / articles / tickers) ──────────────────────────

export interface DataLakeArticlesParams {
  id?: string;
  tags?: string[];
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: 'fileName' | 'createdAt';
  sortDir?: 'asc' | 'desc';
}

/** Response shape for the tag-counts endpoint. */
export interface DataLakeTagCountsResponse {
  /** Tag-occurrence sums that drive the Data Lake Explorer's tag tree. */
  tagCounts: { tag: string; count: number }[];
  /** Distinct-file counts: combined total + per-prefix breakdown (keyed by lake tag prefix, e.g. 'opti:'). */
  uniqueArticleCounts: { total: number; byPrefix: Record<string, number> };
  /**
   * Distinct live files per lake, keyed by `datalakeTag`. This is the number to show for a
   * LAKE: it counts membership, so it stays truthful for files that carry no taxonomy tag and
   * counts a multi-tagged file once. The prefix/occurrence counts above still drive the tag
   * tree's branches.
   */
  lakeFileCounts: Record<string, number>;
}

/**
 * Which browse surface is reading. Both sources now hit the SAME consolidated
 * `/api/data-lakes/*` endpoints (the former product-gated `/api/opti/*` twins
 * were consolidated away - access is lake-scoped via each lake's declared
 * tag/entitlement gate, so the caller's accessible scope is identical either
 * way). The source is kept as a cache-key discriminator for the two UIs.
 */
export type DataLakeBrowseSource = 'opti' | 'datalakes';
const browseBase = (_source: DataLakeBrowseSource) => '/api/data-lakes';

/**
 * Fetches tag counts for the Data Lake Explorer tag tree via server-side aggregation.
 * Much lighter than fetching all articles - returns ~50 tag/count pairs instead of 2000 documents.
 */
export function useGetDataLakeTagCounts(source: DataLakeBrowseSource = 'opti') {
  return useQuery({
    queryKey: dataLakeKeys.tagCounts(source),
    queryFn: async () => {
      const response = await api.get<DataLakeTagCountsResponse>(`${browseBase(source)}/tag-counts`);
      return response.data;
    },
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Truthful Data-Lake article counts (distinct files, NOT tag occurrences) for the hero
 * tickers + mission chips, sourced from the same query the Explorer uses. `total` is the
 * combined unique count; the per-prefix fields are the individual per-lake unique counts.
 * Returns 0 for users without data-lake access (the endpoint yields an empty set); callers
 * fall back to a placeholder rather than rendering "0".
 *
 * `sales` is the unique count for the premium (overlay-contributed) lake - its tag prefix is
 * read from the lake config (DATA_LAKES) rather than hardcoded, so no customer-specific prefix
 * lives in open-core; it is 0 in the fork where no premium lake is contributed.
 */
export function useDataLakeArticleCounts(): { total: number; sales: number; opti: number } {
  const { data } = useGetDataLakeTagCounts();
  const unique = data?.uniqueArticleCounts;
  // The premium lake (if any) is whatever the overlay contributes beyond the base opti lake.
  const premiumLake = DATA_LAKES.find(l => l.id !== 'opti-knowledge');
  // `byPrefix` is keyed by the NORMALIZED prefix, and the premium lake's comes from a JSON env
  // var that is only checked for truthiness - so index it through the same predicate or a
  // padded value silently reads 0.
  const premiumPrefix = premiumLake ? normalizeTagPrefix(premiumLake.fileTagPrefix) : null;
  return {
    total: unique?.total ?? 0,
    sales: premiumPrefix ? (unique?.byPrefix[premiumPrefix] ?? 0) : 0,
    opti: unique?.byPrefix['opti:'] ?? 0,
  };
}

/**
 * Cross-lake browse query (GET /api/data-lakes/articles) - not one lake's file list; see
 * useDataLakeFiles.
 */
export function useGetDataLakeArticles(params?: DataLakeArticlesParams | null, source: DataLakeBrowseSource = 'opti') {
  return useQuery({
    queryKey: dataLakeKeys.articles(source, params),
    queryFn: async () => {
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        `${browseBase(source)}/articles`,
        { params: params ?? undefined }
      );
      return response.data;
    },
    // Disabled when params is null/undefined (lazy-load pattern)
    enabled: params != null,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}
