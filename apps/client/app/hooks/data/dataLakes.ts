import type {
  BrowsePublicDataLakesResult,
  DataLakeConfig,
  IDataLakeBatchDocument,
  IDataLakeBatchSummary,
  IDataLakeSpendResponse,
  IFabFileDocument,
  LakeHealthApiResponse,
  ManageableDataLakeConfig,
  TaxonomyTag,
} from '@bike4mind/common';
import { isAxiosError } from 'axios';
import { DATA_LAKES, normalizeTagPrefix, tagPrefixesOverlap } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType, UpdateDataLakeRequestInputType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
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
 * One lake's derived health report (#1666): the four retrievability predicates and the
 * reachable-content headline, computed on demand from per-file rollups. Advisory only.
 *
 * Fetched only where the badge mounts (the lake detail view) and cached for a few minutes - health
 * shifts only as content is re-ingested, so it does not need to be live. `enabled` stays available
 * for callers that mount it earlier. Like the other lake reads it does not retry the feature-gate 403.
 */
export function useGetDataLakeHealth(dataLakeId: string | null, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.health(dataLakeId ?? ''),
    enabled: enabled && !!dataLakeId,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 2,
    queryFn: async () => {
      const response = await api.get<LakeHealthApiResponse>(`/api/data-lakes/${dataLakeId}/health`);
      return response.data;
    },
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

async function postLifecycle(id: string, action: LifecycleAction) {
  const response = await api.post(`/api/data-lakes/${id}/lifecycle`, { action });
  return response.data;
}

function useLifecycleMutation(action: LifecycleAction, successMessage: string, errorMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postLifecycle(id, action),
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

/**
 * Lakes whose purge the server ACCEPTED (202) but whose background sweep may not have run yet, so
 * GET /api/data-lakes/deleted still lists them. Clearing the row from the cache alone is not
 * enough: the next read of that list re-adds it, and there are two easy triggers - re-expanding
 * the Deleted section, and any sibling lake mutation, since they all invalidate this key
 * (see useLifecycleMutation). Consulted by useGetDeletedDataLakes, which self-prunes each id once
 * a response that could see the purge stops listing it.
 *
 * The value is a sequence number, and it is load-bearing for the prune: a response from a request
 * that STARTED before the purge says nothing about whether the sweep has run, so pruning on it would
 * un-hide a row that is still mid-purge. Purges and fetch-starts both tick the same counter, which
 * orders them exactly - a wall clock cannot, since both can land inside the same millisecond.
 *
 * Module-scoped so it survives the section remounting. Deliberate consequence: if a sweep fails
 * permanently (message DLQs), the row stays hidden until a reload rather than reappearing.
 */
const purgingLakes = new Map<string, number>();
let purgeOrderTick = 0;
const nextPurgeOrderTick = () => ++purgeOrderTick;

/**
 * Test-only: drops all pending-purge suppression AND rewinds the order counter, so module state
 * cannot leak between cases. Double-underscore prefix marks it as not-for-app-code (matching
 * `__resetAllSessionMovesForTests` in chessSessionState.ts).
 */
export function __resetPurgingLakesForTests() {
  purgingLakes.clear();
  purgeOrderTick = 0;
}

/**
 * Phase 2 of permanent delete: irreversible hard-delete sweep.
 *
 * The only lifecycle action that answers 202-queued rather than doing the work inline: the sweep
 * runs in a background consumer (see the timeout note in pages/api/data-lakes/[id]/lifecycle.ts),
 * so the lake is still `status: 'deleted'` when this mutation resolves. Refetching the deleted
 * list here would therefore re-render the very row it was meant to clear, which is what kept a
 * purged lake visible until the section was collapsed and re-expanded. Clear the row from the
 * cache and hold the id in `purgingLakes` until the server agrees it is gone.
 */
export function useCleanupDataLake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postLifecycle(id, 'cleanup'),
    onSuccess: (_data, id) => {
      // Record the suppression BEFORE touching the cache: an in-flight fetch resolves through the
      // queryFn, which reads this map, so a response landing after this line already hides the row.
      purgingLakes.set(id, nextPurgeOrderTick());
      // Deliberately NOT cancelling an in-flight deleted-list fetch. The queryFn filter makes it
      // harmless, and cancelling reverts the query to its pre-fetch snapshot - which would discard a
      // refetch a sibling mutation had started (e.g. a restore of another lake) and leave that other
      // lake shown under Deleted until something else refetched.
      queryClient.setQueryData<DataLakeConfig[]>(dataLakeKeys.deleted, old => old?.filter(lake => lake.id !== id));
      // Deliberately NOT invalidating dataLakeKeys.list: ['data-lakes'] prefix-matches
      // ['data-lakes', 'deleted'], so it would refetch the list above and undo the removal. No
      // other catalog changes either - a purgeable lake is already soft-deleted, so it is
      // already absent from the active/archived/public lists.
      toast.success('Data lake permanently purged');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to clean up data lake');
    },
  });
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

/**
 * Lists soft-deleted data lakes (management view: restore / purge), minus any whose purge has been
 * accepted but not yet swept - see `purgingLakes`. Filtering here rather than at the call site
 * means no refetch of this key can resurrect a purged row, whatever triggered it - including a
 * fetch that was already in flight when the purge landed.
 */
export function useGetDeletedDataLakes(enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.deleted,
    enabled,
    queryFn: async () => {
      const startedAt = nextPurgeOrderTick();
      const response = await api.get<{ data: DataLakeConfig[] }>('/api/data-lakes/deleted');
      const lakes = response.data.data;
      // Self-prune, so the map cannot outlive the purges it describes: once the sweep has removed a
      // lake, stop tracking it. Only a request that STARTED after the purge can settle that - an
      // older one may predate the soft-delete entirely, and pruning on it would un-hide the row.
      for (const [id, purgedAt] of purgingLakes) {
        if (purgedAt < startedAt && !lakes.some(lake => lake.id === id)) purgingLakes.delete(id);
      }
      return lakes.filter(lake => !purgingLakes.has(lake.id));
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
      if (dataLakeId) {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
        // Reprocessing changes the chunk/vector rollups health is computed from. The final figures
        // land only once vectorization finishes (async); the badge refreshes then via its staleTime.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
        // Re-chunking a file that was an oversized blob drops it from the under-chunked set, so the
        // "Rebuild passages" badge must refresh too (it otherwise only self-heals on its next poll).
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
      }
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
      if (dataLakeId) {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
        // Removing a member changes the lake's reachable-content denominator and predicate tallies.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
        // Removing a file can drop the lake's under-chunked count, so refresh the rebuild badge.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
      }
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

export type LakeRebuildStatus = { underChunkedCount: number; failedCount: number };

/** Extra polls after the backlog clears, at SETTLE_MS each - about three minutes of cover. */
const REBUILD_SETTLE_POLLS = 18;
const REBUILD_SETTLE_MS = 10_000;

export type RebuildPollState = { sawBacklog: boolean; settlePolls: number };
export const INITIAL_REBUILD_POLL_STATE: RebuildPollState = { sawBacklog: false, settlePolls: 0 };

/**
 * Poll cadence for the rebuild badge, as a pure function so it can be tested without mounting the
 * hook (the two defects this logic has carried both shipped because nothing executed it).
 *
 * `underChunkedCount` is the loop condition and `failedCount` deliberately is NOT: a failed file
 * never retries on its own (see countFailedFilesByScope - it is invisible to both the detection
 * query and the rescue sweep), so summing the two gives a term that can never reach zero and the
 * badge polls forever on any lake holding one. But the count alone stops too early: it drops the
 * instant a wave is RESET, minutes before those chunk jobs finish, and a job that then fails
 * surfaces only in failedCount. So once the backlog clears we keep polling a bounded number of
 * extra times to catch that, then stop for good.
 */
export function nextRebuildPoll(
  underChunkedCount: number,
  prev: RebuildPollState
): { interval: number | false; next: RebuildPollState } {
  if (underChunkedCount > 0) {
    const interval = underChunkedCount > 200 ? 30_000 : underChunkedCount > 50 ? 15_000 : 5_000;
    return { interval, next: { sawBacklog: true, settlePolls: 0 } };
  }
  // Never had anything to rebuild in this session - nothing to settle for.
  if (!prev.sawBacklog || prev.settlePolls >= REBUILD_SETTLE_POLLS) return { interval: false, next: prev };
  return { interval: REBUILD_SETTLE_MS, next: { ...prev, settlePolls: prev.settlePolls + 1 } };
}

/**
 * Hook: the lake's rebuild status - how many files are still oversized passages (predating the
 * passage-target fix) plus how many gave up (failed re-chunk). Polls itself down while a rebuild
 * drains, backing off as the backlog stays large so a multi-thousand-file lake isn't re-scanned
 * every 5s for the whole drain. Rebuild-capable surface, so only enable when the viewer can
 * REBUILD (`canRebuild`) - narrower than `canManage`, since a fallback (built-in) lake has no
 * document to manage but can still be rebuilt by a platform admin.
 */
export function useUnderChunkedCount(dataLakeId: string | null, enabled = true) {
  const pollState = useRef<RebuildPollState>({ ...INITIAL_REBUILD_POLL_STATE });
  return useQuery({
    // Same null sentinel as the sibling lake queries. Never fetched either way (the query is disabled
    // when the id is null), but two spellings side by side in one file invite a real divergence later.
    queryKey: dataLakeKeys.rebuildStatus(dataLakeId ?? ''),
    queryFn: async (): Promise<LakeRebuildStatus> => {
      const res = await api.get<LakeRebuildStatus>(`/api/data-lakes/${dataLakeId}/rechunk`);
      return { underChunkedCount: res.data.underChunkedCount, failedCount: res.data.failedCount ?? 0 };
    },
    enabled: enabled && !!dataLakeId,
    // Tick down as waves complete; coarser cadence while the backlog is large (each poll is a full
    // lake rescan), then a bounded settle window before going quiet. See nextRebuildPoll.
    refetchInterval: query => {
      const { interval, next } = nextRebuildPoll(query.state.data?.underChunkedCount ?? 0, pollState.current);
      pollState.current = next;
      return interval;
    },
  });
}

/**
 * Hook: re-chunk a bounded wave of the lake's under-chunked files. Server picks the worst
 * offenders first and caps the wave; call again (the badge shows `remaining`) to drain the rest.
 */
export function useRechunkDataLake(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limit?: number) => {
      const res = await api.post<{ detected: number; enqueued: number; remaining: number }>(
        `/api/data-lakes/${dataLakeId}/rechunk`,
        limit ? { limit } : {}
      );
      return res.data;
    },
    onSuccess: data => {
      toast.success(
        data.enqueued > 0
          ? `Rebuilding ${data.enqueued} file(s) into passages - ${data.remaining} remaining.`
          : 'All files are already chunked into passages.'
      );
      if (dataLakeId) {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
        // A rebuild mass-mutates the exact rollups health is computed from, and the health query has
        // no refetchInterval and does not refetch on focus - its observer stays mounted while the
        // panel re-renders, so staleTime alone never refreshes it. Without this the badge sits frozen
        // for the whole rebuild while the "to rebuild" chip ticks to zero beside it, which reads as
        // "the rebuild accomplished nothing". The other two lake mutations already invalidate both.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to start rebuild');
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
    // `null` means disabled-below, but the key type takes the params shape or undefined only.
    queryKey: dataLakeKeys.articles(source, params ?? undefined),
    queryFn: async () => {
      // Serialized by hand because of an axios/Next disagreement on arrays: axios writes
      // `tags[]=x`, Next's query parser keeps the literal key `tags[]`, and the handler reads
      // `query.tags` - so the tag filter silently vanished and a leaf category showed whatever
      // happened to be in the first alphabetical page. Repeated bare keys (`tags=x&tags=y`)
      // parse into exactly the string | string[] shape DataLakeArticlesQuery declares.
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value == null) continue;
        for (const v of Array.isArray(value) ? value : [value]) search.append(key, String(v));
      }
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        `${browseBase(source)}/articles?${search.toString()}`
      );
      return response.data;
    },
    // Disabled when params is null/undefined (lazy-load pattern)
    enabled: params != null,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * One lake's spend view: lifetime meter, live budget levers, and the byModel/byFeature/
 * overTime ledger breakdown. `enabled` is passed by the caller so the modal can fetch lazily -
 * only once the Spend tab is actually opened, not on every settings-modal mount.
 *
 * Any 4xx (not just 403) is treated as "forbidden": a fallback/hardcoded lake has no
 * `createdByUserId` and no grants, so `canManageLake` fails closed for every non-admin caller
 * there too (a 403 via the same gate, not a distinct mechanism) - treating any 4xx as
 * "forbidden" is a deliberately wider net than hardcoding 403, so an unanticipated 4xx also
 * hides the tab instead of painting a red error.
 */
export function useDataLakeSpend(dataLakeId: string | null, days: number, opts?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: dataLakeKeys.spend(dataLakeId, days),
    queryFn: async () => {
      const { data } = await api.get<IDataLakeSpendResponse>(`/api/data-lakes/${dataLakeId}/spend`, {
        params: { days },
      });
      return data;
    },
    enabled: !!dataLakeId && (opts?.enabled ?? true),
    // A permission rejection must never be retried - matches useGetDataLakes' own rationale.
    retry: false,
    staleTime: 1000 * 60,
    placeholderData: keepPreviousData,
  });
  const isForbidden =
    isAxiosError(query.error) &&
    (query.error.response?.status ?? 0) >= 400 &&
    (query.error.response?.status ?? 0) < 500;
  return { ...query, isForbidden };
}
