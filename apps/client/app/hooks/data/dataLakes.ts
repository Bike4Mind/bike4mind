import type {
  BrowsePublicDataLakesResult,
  DataLakeConfig,
  DataLakeDocumentPurgeReceipt,
  DataLakeMembershipArm,
  DataLakeProposalStatus,
  IDataLakeProposalDocument,
  IDataLakeBatchDocument,
  IDataLakeBatchSummary,
  IDataLakeSpendResponse,
  IFabFileDocument,
  LakeAccessView,
  LakeOwnershipCandidateList,
  LakeHealthApiResponse,
  LakeConfigHistoryView,
  ManageableDataLakeConfig,
  TaxonomyTag,
} from '@bike4mind/common';
import { isAxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import { DATA_LAKES, normalizeTagPrefix, tagPrefixesOverlap } from '@bike4mind/common';
import type {
  CreateDataLakeRequestInputType,
  UpdateDataLakeRequestInputType,
  UpdateFallbackLakeSettingsRequestInputType,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { toast } from 'sonner';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { invalidateGearsStatusWhileLocked } from '@client/app/hooks/useGearsStatus';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';

/**
 * True for a 4xx, which on the manage-gated lake reads (spend, proposals) means "you may see this
 * lake but not this surface". Callers hide the surface on it rather than painting an error, so it
 * must not widen to 5xx - a server fault is a real error and should read as one.
 */
function isPermissionRejection(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status ?? 0;
  return status >= 400 && status < 500;
}

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
 * One lake's config-change history (#1769): who changed how this lake answers, what moved, and which
 * manage rung authorized it. Manager-only server-side - a mere reader gets a 403.
 *
 * `staleTime: 0` unlike the other lake reads, because this surface mounts in the same modal that
 * EDITS the lake: a cached history would show an owner their own just-saved change as absent, which
 * reads as "the audit missed it" - the one impression an audit surface must never give. `retry: false`
 * matches the sibling reads (the feature-gate 403 and the manage 403 are both terminal, not transient).
 */
export function useLakeConfigHistory(dataLakeId: string | null, enabled = true, limit?: number) {
  const query = useQuery({
    queryKey: dataLakeKeys.configHistory(dataLakeId, limit),
    enabled: enabled && !!dataLakeId,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    queryFn: async () => {
      const response = await api.get<{ data: LakeConfigHistoryView }>(
        `/api/data-lakes/${dataLakeId}/config-history`,
        limit == null ? undefined : { params: { limit } }
      );
      return response.data.data;
    },
  });
  // Same derivation as useDataLakeSpend, and used the same way: a rejection RETRACTS the surface
  // rather than painting an error into it. Both of this route's refusals are permission-shaped (the
  // EnableDataLakes gate and the manage gate), and neither becomes true by retrying.
  const isForbidden =
    isAxiosError(query.error) &&
    (query.error.response?.status ?? 0) >= 400 &&
    (query.error.response?.status ?? 0) < 500;
  return { ...query, isForbidden };
}

/**
 * The owner-facing access & membership view for one lake (#1672): who can reach it (grants +
 * gate-based channels, expiry resolved live) and who actually read it (the audit trail). Manager-
 * only server-side (403 for a mere reader), so callers gate the entry point on `canManage` and pass
 * `enabled` only when a manageable lake is open. Short staleTime: this is a compliance surface an
 * owner refreshes intentionally, not a display hint. The 403/404 is never retried.
 */
export function useLakeAccessView(dataLakeId: string | null, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.access(dataLakeId ?? ''),
    enabled: enabled && !!dataLakeId,
    retry: false,
    queryFn: async () => {
      const response = await api.get<{ data: LakeAccessView; meta?: { canTransferOwnership?: boolean } }>(
        `/api/data-lakes/${dataLakeId}/access`
      );
      // The capability is kept OUT of the view object it sits beside: the view is the artifact the CSV
      // export mirrors, and a per-viewer permission is not a fact about the lake's access.
      // Fails closed - an older server that omits `meta` hides the control rather than showing one
      // whose action would 400.
      return {
        view: response.data.data,
        canTransferOwnership: response.data.meta?.canTransferOwnership === true,
      };
    },
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

/**
 * Who the current user may transfer one lake to (the transfer picker's options). Server-resolved from
 * the owning org's membership using the same rule the transfer itself validates, so the list can never
 * offer a teammate the action would reject; a caller who may read but not transfer simply gets an
 * empty list. Enabled only while the transfer dialog is open - this is a picker's option set, not a
 * display hint, so it is fetched on demand and not cached long.
 */
export function useLakeOwnershipCandidates(dataLakeId: string | null, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.ownershipCandidates(dataLakeId ?? ''),
    enabled: enabled && !!dataLakeId,
    retry: false,
    queryFn: async () => {
      const response = await api.get<{ data: LakeOwnershipCandidateList }>(
        `/api/data-lakes/${dataLakeId}/transfer-ownership`
      );
      return response.data.data;
    },
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

/**
 * Hand a lake's ownership to another user. The prior owner is demoted to curator rather than removed,
 * so they keep management access and the transfer is reversible by the new owner.
 *
 * Invalidates the lake list as well as the access view: ownership decides `canManage`, so the panel's
 * own controls (Access included) may legitimately disappear for the actor once they are no longer the
 * owner - refetching is what keeps the UI honest about what the actor can still do.
 */
export function useTransferLakeOwnership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, newOwnerUserId }: { id: string; newOwnerUserId: string }) => {
      const response = await api.post<{ newOwnerUserId: string; demotedUserIds: string[] }>(
        `/api/data-lakes/${id}/transfer-ownership`,
        { newOwnerUserId }
      );
      return response.data;
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipCandidates(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      toast.success('Data lake ownership transferred');
    },
    onError: (error: Error) => {
      // Surface the server's own refusal text. This endpoint's rejections are the actionable kind
      // ("name another member", "must belong to the organization that owns this data lake"), and
      // axios would otherwise replace them with "Request failed with status code 400". The body key
      // is `error`, per the API error handler (server/middlewares/errorHandler.ts).
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(refusal || error.message || 'Failed to transfer ownership');
    },
  });
}

/**
 * Download the same access view as a CSV compliance artifact. Must go through the authenticated axios
 * instance: the access token is held in memory and attached as an `Authorization` header, so a plain
 * link or `window.open` would carry no credentials at all. Hence the blob + object-URL + anchor click,
 * with the URL revoked afterward.
 */
export async function downloadLakeAccessCsv(dataLakeId: string): Promise<void> {
  const response = await api.get(`/api/data-lakes/${dataLakeId}/access`, {
    params: { format: 'csv' },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(response.data as Blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lake-access-${dataLakeId}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
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
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      // This write is exactly what adds a config-history row, and the history renders in the same
      // modal that submitted it - without this the owner sees their own change missing from the audit.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
      // This mutation is the ONLY writer of `requiredPassageTokenTarget`, and that value is the sole
      // input both the health report (#1666) and the convergence plan (#1681) are graded against -
      // change it and which files are conformant, the reachable-content headline, the convergeable
      // count and the bulk-change share all move at once. Neither query polls or refetches on focus,
      // so without this they keep rendering the pre-change verdict against the new policy.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.convergencePlan(id) });
      toast.success('Data lake updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update data lake');
    },
  });
}

/**
 * Edit a STATIC (registry) lake's admin-settable overlay (currently `groundingMode` only). A
 * separate mutation from `useUpdateDataLake` on purpose: it targets PUT /api/data-lakes/:id/settings,
 * not the general update route, which refuses a fallback lake outright.
 */
export function useUpdateFallbackLakeSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...params }: UpdateFallbackLakeSettingsRequestInputType & { id: string }) => {
      const response = await api.put<DataLakeConfig>(`/api/data-lakes/${id}/settings`, params);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      toast.success('Data lake settings updated');
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update data lake settings');
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
    onSuccess: (_data, { id, visibility }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      // A visibility change records a config-history row, same as an update. Not relying on the
      // History tab's staleTime:0 + enabled-toggle refetch: that pairing happens to refresh today,
      // but it is incidental, and raising staleTime or dropping the toggle would silently strand
      // the new row.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
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
 * Browse the public-lake discovery catalog: the public lakes this caller can reach, across all
 * orgs (gate-less ones plus any gated public lake whose gate the caller holds), with
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
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.archived });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.deleted });
      // A lifecycle move changes what is BROWSABLE, not just which lakes are listed: archiving
      // stamps archivedAt on the lake's files, which both tag counters exclude. Without this the
      // lake list and the tag tree disagree - the page's lake rail (sourced from `list`) drops the
      // row while the tree beside it still shows that lake's branches and counts it in the totals.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
      // Every lifecycle action records a config-history row. Invalidated for all five rather than
      // only the reversible ones: for delete/cleanup the history observer is already unmounted, so
      // the extra key is inert, and enumerating which actions qualify would rot as actions are added.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
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
 * Lakes whose purge the server ACCEPTED (202), held hidden until a fetch confirms they are gone.
 *
 * KEPT DELIBERATELY, and narrowed in what it is for (#1744). The server now claims
 * `deleted -> purging` at accept time, so `GET /api/data-lakes/deleted` stops listing a purged lake
 * immediately and every other tab, session and future consumer is covered without this map. What is
 * still left for it is the gap this side owns and the server cannot see: the in-flight requests
 * around the accept - a deleted-list fetch that STARTED before the purge can land after it, carrying
 * a payload that still names the lake. Removing it would trade a small, purely local guard for a
 * visible flicker of a row the user just purged. The two mechanisms are a documented pair now, not
 * belt-and-braces by accident.
 *
 * Clearing the row from the cache alone is not enough: the next read of that list re-adds it, and
 * there are two easy triggers - re-expanding the Deleted section, and any sibling lake mutation,
 * since they all invalidate this key (see useLifecycleMutation). Consulted by
 * useGetDeletedDataLakes, which self-prunes each id on the first response from a request that
 * STARTED after the purge, whether or not that response still lists the lake.
 *
 * The value is a sequence number, and it is load-bearing for the prune: a response from a request
 * that STARTED before the purge says nothing about whether the sweep has run, so pruning on it would
 * un-hide a row that is still mid-purge. Purges and fetch-starts both tick the same counter, which
 * orders them exactly - a wall clock cannot, since both can land inside the same millisecond.
 *
 * Module-scoped so it survives the section remounting. What keeps a row hidden after a sweep that
 * failed permanently (message DLQs) is not this map, which prunes on the next post-accept fetch
 * either way - it is the SERVER omitting a lake still sitting in 'purging' (#1744). The map's only
 * remaining job is the in-flight fetch that started before the accept and lands after it, carrying
 * a payload that still names the lake.
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
 * runs in a background consumer (see the timeout note in pages/api/data-lakes/[id]/lifecycle.ts).
 * The server does now move the lake to `status: 'purging'` before answering (#1744), so a refetch
 * that STARTS after this resolves correctly omits the row - but one already in flight does not, and
 * this mutation cannot tell the two apart. So the cache write stays: clear the row and hold the id
 * in `purgingLakes` until a response that could see the purge stops listing it. Before the server
 * fix this was the only thing hiding the row at all, which is why it is written as a guard rather
 * than an optimization.
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
      // Self-prune, so the map cannot outlive the purges it describes. A response from a request
      // that STARTED after the purge is authoritative either way, now that the server omits a
      // 'purging' lake (#1744): ABSENT means the sweep finished, PRESENT means the consumer refused
      // the purge and released it back to 'deleted', and that row must come back. Also requiring
      // absence would strand a released lake hidden in this tab until a full reload - precisely the
      // case the server-side release exists to recover. An OLDER request still settles nothing: one
      // that started before the accept may not have seen the soft-delete at all.
      for (const [id, purgedAt] of purgingLakes) {
        if (purgedAt < startedAt) purgingLakes.delete(id);
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
 * A lake member as this browse returns it: the file plus which membership arm made it one -
 * `meta` (the lake's `datalake:*` tag), `prefix` (a `fileTagPrefix` content tag on a file the
 * creator owns, no meta-tag), or `both`. Undefined only if the server predates this field.
 */
export type DataLakeMemberFile = IFabFileDocument & { membershipArm?: DataLakeMembershipArm };

/**
 * Hook: Fetch files belonging to a specific data lake by ID.
 * One lake's own file list (GET /api/data-lakes/{id}/articles) - not the cross-lake browse
 * query; see useGetDataLakeArticles.
 */
export function useDataLakeFiles(dataLakeId: string | null, params?: { limit?: number }) {
  return useQuery({
    queryKey: dataLakeKeys.files(dataLakeId, params),
    queryFn: async () => {
      const response = await api.get<{ data: DataLakeMemberFile[]; total: number; hasMore: boolean }>(
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
 * The invalidation fan-out shared by a removal and a restore - both change the same lake's
 * membership, so a caller left stale by one is left stale by the other. Kept in one place so
 * `useRemoveFileFromDataLake` and `useAddFileToDataLake` cannot drift apart on what "membership
 * changed" invalidates.
 *
 * Exported so a future hook for `PUT /api/data-lakes/:id/files/:fabFileId/tags`
 * (`setDataLakeFileTags`) can reuse it: that door can also change a file's tags under this lake's
 * prefix (and, via a prefix-arm join, another lake's membership), which is exactly the same
 * invalidation shape.
 */
export function invalidateLakeFileMembershipQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  dataLakeId: string
) {
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
  // Membership changes the lake's reachable-content denominator and predicate tallies.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
  // A membership change can move the lake's under-chunked count, so refresh the rebuild badge.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
  // A membership write can reach activateIfDraft's draft -> active flip (see
  // removeFileFromDataLake / addFileToDataLake), which records a `system`-principal
  // config-history row. Inert today because these hooks fire from the file wizard, where the
  // History observer is unmounted - invalidated anyway for the same reason the lifecycle hook
  // does it: the cost is nothing, and reasoning about which paths qualify is what rots.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(dataLakeId) });
  // Refresh the lake list to pick up the recomputed stats. fileCount counts meta-tagged
  // files only, so a membership change scoped to a prefix-only file moves rows without
  // moving the count.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
  // Membership also changes the file's tags under the lake's prefix, so every tag-derived view
  // is stale (incl. the manager's count-chip fallback). Root prefixes: these caches are
  // keyed by an opti/datalakes source discriminator, and a fully-specified key would
  // refresh only one surface.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.articlesRoot });
  // Bare prefix: the tag list carries a fileCount derived from the files that hold each tag,
  // so a membership change stales the list too, not only the counts endpoint.
  queryClient.invalidateQueries({ queryKey: ['file-tags'] });
}

/** How long the Undo toast stays visible - long enough to notice, short of feeling stuck open.
 *  The server's removal record outlives it by a lot (30 minutes - see removeFileFromDataLake), but
 *  this toast is the ONLY affordance that spends it: there is no list route and no "recently
 *  removed" panel, so once it closes the restore is reachable only by calling the route directly.
 *  The non-owner confirmation copy says so, because for a non-owner there is no second way back. */
const UNDO_TOAST_DURATION_MS = 15000;

/** `toastId` is presentation, not payload - the server reads nothing but the two ids from the
 *  route. It travels in the variables so `useAddFileToDataLake`'s callbacks can live at the
 *  MUTATION level and still address the toast that triggered them; see the comment there. */
export interface AddFileToDataLakeVariables {
  dataLakeId: string;
  fabFileId: string;
  toastId?: string | number;
}

/**
 * Hook: restore a file to a data lake - either an Undo of a recent removal (the server's own
 * short-TTL removal record supplies the real tags) or a cold add of a file the actor owns. The
 * server decides which path applies; this hook sends nothing that could select one - no
 * `restoreTags`, nothing beyond the ids.
 *
 * Takes the lake id PER CALL, not at hook construction - see `useRemoveFileFromDataLake`'s Undo
 * wiring for why a hook-level id is the wrong shape for an action that fires long after the
 * confirming component may have cleared its own state.
 */
export function useAddFileToDataLake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ dataLakeId, fabFileId }: AddFileToDataLakeVariables) => {
      const res = await api.post<{ success: true; fileCount: number; totalSizeBytes: number }>(
        `/api/data-lakes/${dataLakeId}/files/${fabFileId}`
      );
      return res.data;
    },
    // BOTH callbacks are MUTATION-level, and `toastId` rides in the variables purely so they can be.
    // Per-`mutate()` callbacks are dispatched only while the observer still has listeners
    // (mutationObserver's `#notify` guards on `hasListeners()`, and useMutation subscribes via
    // useSyncExternalStore), and the only caller is an Undo button on a toast that OUTLIVES the
    // component holding this hook: confirming a removal unmounts the dialog on both wizard
    // surfaces. Per-call callbacks there fire for nobody, so a failed restore was silent - on the
    // one affordance the user has, promised by the confirmation copy.
    onSuccess: (_data, { dataLakeId, toastId }) => {
      invalidateLakeFileMembershipQueries(queryClient, dataLakeId);
      if (toastId !== undefined) toast.success('File restored to data lake.', { id: toastId });
    },
    onError: (error: Error, { toastId }) => {
      // Surface the server's own refusal text, not axios' `"Request failed with status code N"`.
      // Every actionable rejection on this door lands here - "You do not have permission to add
      // files to this data lake", "Data lake not found", the built-in-lake refusal - and this is
      // the toast the non-owner confirmation copy calls their only way back, so a status string is
      // the one message that cannot help them. Body key is `error` (server/middlewares/
      // errorHandler.ts); same extraction as useTransferLakeOwnership above.
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      const message = refusal || error.message || 'Failed to restore the file to the data lake';
      toast.error(message, toastId !== undefined ? { id: toastId } : undefined);
    },
  });
}

/**
 * Hook: Remove a single file from a data lake. Drops the lake's membership tags from the file
 * and leaves the file itself alone - no soft-delete, no chunk teardown. Owner/admin only; the
 * server verifies the file actually belongs to the lake.
 *
 * Offers Undo on the success toast, backed by the server's short-TTL removal record (#2248) - not
 * by anything captured client-side, since there is nothing left to capture: the tags to restore
 * live on the server.
 */
export function useRemoveFileFromDataLake(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  const addFileToDataLake = useAddFileToDataLake();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.delete<{ success: true; fileCount: number; totalSizeBytes: number }>(
        `/api/data-lakes/${dataLakeId}/files/${fabFileId}`
      );
      return res.data;
    },
    onSuccess: (_data, fabFileId) => {
      if (dataLakeId) {
        invalidateLakeFileMembershipQueries(queryClient, dataLakeId);
      }

      if (!dataLakeId) {
        toast.success('File removed from data lake.');
        return;
      }
      // Captured NOW, in this closure - not read later off the hook's own `dataLakeId` prop, which
      // a caller typically nulls out (clearing its confirm-dialog target) as soon as this onSuccess
      // returns. The Undo button's onClick below closes over this constant, not over the hook.
      const removedLakeId = dataLakeId;
      const toastId = toast.success('File removed from data lake.', {
        duration: UNDO_TOAST_DURATION_MS,
        action: {
          label: 'Undo',
          onClick: () => {
            // No per-call callbacks: this click routinely happens after the component holding the
            // hook has unmounted, which is exactly when those are dropped. The toast id goes in the
            // variables instead so the mutation-level handlers can replace this toast in place.
            addFileToDataLake.mutate({ dataLakeId: removedLakeId, fabFileId, toastId });
          },
        },
      });
    },
    onError: (error: Error) => {
      // Same extraction as the restore door above: these two fire from the same confirmation
      // dialog, so leaving this one bare would give Undo the server's reason and Remove a status
      // code. `Only the creator can remove files from this data lake` is exactly the text a
      // curator needs here.
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(refusal || error.message || 'Failed to remove file from data lake');
    },
  });
}

/**
 * Hook: permanently destroy one lake document, its chunks and its vectors, and keep the receipt
 * the server returns as proof. The reversible sibling is `useRemoveFileFromDataLake`, which only
 * unpicks lake membership - this one is unrecoverable and removes the file everywhere, so the
 * caller is expected to confirm first and to show the receipt afterwards.
 *
 * A receipt with `verified: false` is surfaced as a warning, not a success: the request completed
 * but the sweep did not converge, and telling the owner their content is gone would be a claim
 * the server explicitly declined to make.
 */
export function usePurgeDataLakeDocument(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.post<DataLakeDocumentPurgeReceipt>(
        `/api/data-lakes/${dataLakeId}/files/${fabFileId}/purge`
      );
      return res.data;
    },
    onSuccess: receipt => {
      if (receipt.verified) {
        toast.success(
          `Deleted permanently: the document and its ${receipt.chunksBefore} chunk(s) and vectors are gone.`
        );
      } else {
        toast.error(`Deletion did not finish: ${receipt.chunksRemaining} chunk(s) still remain.`);
      }
      // `filesRoot`, not `filesOf(dataLakeId)`: membership removal is lake-scoped and this is not,
      // so any OTHER lake's cached file list is stale too.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesRoot });
      // Health is computed from the chunk/vector rollups this purge destroys outright, so the badge
      // would otherwise keep counting the destroyed document's chunks as reachable content until it
      // goes stale. Root prefix for the same reason as filesRoot: every lake that held the document
      // is affected, not just this one.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.healthRoot });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.articlesRoot });
      queryClient.invalidateQueries({ queryKey: ['file-tags'] });
      // The document is gone globally, not just from this lake, so the Files list is stale too.
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      if (dataLakeId) {
        // Purging an under-chunked document can move the purged lake's rebuild badge, and can
        // reach recomputeLakeStats' draft -> active flip, which writes a config-history row - same
        // two keys invalidateLakeFileMembershipQueries refreshes for a membership change.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(dataLakeId) });
      }
    },
    onError: (error: Error) => {
      // Same extraction as the other lake doors: this is the irreversible one, and a mid-sweep
      // failure is exactly the case where "Request failed with status code 500" is the one message
      // that cannot tell the owner whether their document is half destroyed. Body key is `error`
      // (server/middlewares/errorHandler.ts).
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(refusal || error.message || 'Failed to permanently delete this file');
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
        // A rebuild re-chunks files, which restamps the very fields the convergence plan grades
        // (the chunk target and the largest-chunk length) - so the sibling action's counts move too.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.convergencePlan(dataLakeId) });
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to start rebuild');
    },
  });
}

/**
 * The convergence plan (#1681): what a run WOULD rewrite, what it refuses and why, and whether the
 * size of the change needs an explicit confirmation. Read-only - safe to fetch for any reader.
 *
 * Refusals a caller must render rather than swallow:
 *  - `refusal: 'policyInherited'` - the lake declares no chunk policy of its own, so it is measured
 *    by health but never repaired (epic decision 5).
 *  - `crossLakeConflictCount` - members another lake requires a different chunk target for.
 *    Repairing them would make the two lakes take turns rewriting the file forever.
 */
export interface LakeConvergencePlanResponse {
  refusal: 'policyInherited' | null;
  policy: { requiredTarget: number; effectiveRequiredTarget: number; policyChars: number };
  membersConsidered: number;
  /** Whole-lake drift, BEFORE the per-wave cross-lake check. Not an action count - see `waveSize`. */
  convergeableCount: number;
  /** What a run would actually enqueue now. THE number to label the action with. */
  waveSize: number;
  changeShare: number;
  requiresConfirmation: boolean;
  bulkChangeShareThreshold: number;
  skipped: {
    conformant: number;
    unmeasured: number;
    indexingInFlight: number;
    previouslyFailed: number;
    irreducibleOvershoot: number;
  };
  crossLakeConflicts: {
    fabFileId: string;
    fileName?: string;
    // Both optional: the GET is read-gated and strips them (`redactCrossLakeIdentities`), so typing
    // `name` as required would have TypeScript vouch for a field the redaction guarantees is absent.
    conflictingLakes: { lakeId?: string; name?: string; effectiveRequiredTarget: number }[];
  }[];
  crossLakeConflictCount: number;
  scanTruncated: boolean;
}

export type LakeConvergenceRunResponse = LakeConvergencePlanResponse & {
  /**
   * `noop` = the run was allowed but had nothing it could repair (see the toast for why).
   * `paused` = the convergence kill switch is on, so the run refused BEFORE touching any file.
   */
  outcome: 'enqueued' | 'noop' | 'paused' | 'confirmationRequired' | 'policyInherited';
  detected: number;
  enqueued: number;
  /** Members reset but never enqueued (every send failed) - out of search with nothing rebuilding them. */
  stranded: number;
};

/** Hook: read a lake's convergence plan. Not polled - it is a preview, refreshed by the mutation. */
export function useLakeConvergencePlan(dataLakeId: string | null, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.convergencePlan(dataLakeId ?? ''),
    queryFn: async (): Promise<LakeConvergencePlanResponse> => {
      const res = await api.get<LakeConvergencePlanResponse>(`/api/data-lakes/${dataLakeId}/converge`);
      return res.data;
    },
    enabled: enabled && !!dataLakeId,
  });
}

/**
 * Hook: run one bounded convergence wave. `confirm` is only consulted when the plan trips the
 * bulk-change guard, and the caller must have shown the user the share it is confirming - the guard
 * exists to stop a mass rewrite nobody looked at, so passing it unconditionally defeats it.
 */
export function useConvergeDataLake(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { limit?: number; confirm?: boolean } = {}) => {
      const res = await api.post<LakeConvergenceRunResponse>(`/api/data-lakes/${dataLakeId}/converge`, vars);
      return res.data;
    },
    onSuccess: data => {
      if (data.outcome === 'policyInherited') {
        toast.error('This lake has no chunk policy of its own, so there is nothing to converge toward.');
      } else if (data.outcome === 'paused') {
        toast.warning(
          'Background lake work is paused, so nothing was started. No files were changed - re-run this once ' +
            'an administrator turns convergence back on.'
        );
      } else if (data.outcome === 'confirmationRequired') {
        // Not an error toast: the guard fired as designed and the dialog now shows the share.
        toast.warning(
          `This would rewrite ${Math.round(data.changeShare * 100)}% of the lake (${data.convergeableCount} of ` +
            `${data.membersConsidered} files). Confirm to continue.`
        );
      } else if (data.enqueued > 0) {
        toast.success(
          `Converging ${data.enqueued} file(s) to the lake's chunk policy. ` +
            'They are unsearchable until re-indexing completes.'
        );
        // A PARTIAL queue failure - some sends landed, some were rejected - takes this arm and never
        // reaches the `stranded` branch below, so the success toast alone would report only the good
        // half. The rejected files are in the state that branch describes: reset, their chunk rows
        // orphaned, out of search, with nothing scheduled to rebuild them. A throttle or a handful of
        // rejected sends is at least as likely as a total outage, so this is appended rather than
        // restructuring the chain, which would lose the count of what DID start.
        if (data.stranded > 0) {
          toast.error(
            `${data.stranded} of them could not be started - the chunking queue rejected the request. Those files ` +
              'are out of search until this run is repeated.'
          );
        }
      } else if (data.stranded > 0) {
        // Files were reset and then nothing reached the queue. Checked before the two "nothing to
        // do" branches below: these are sitting at chunked:false / chunkCount:0 with their old chunk
        // rows orphaned, so the one thing this must not say is that the lake is fine. An error, not
        // a warning - unlike a cross-lake refusal this is infrastructure failing, and repeating the
        // run is the action that fixes it.
        toast.error(
          `Could not start convergence for ${data.stranded} file(s) - the chunking queue rejected the request. ` +
            'Those files are out of search until this run is repeated; if it keeps failing, contact an administrator.'
        );
      } else if (data.crossLakeConflictCount > 0) {
        // Must NOT read as "already converged". The lake still has off-policy files; they simply
        // cannot be repaired from here, and saying otherwise would send the owner away from the one
        // action that fixes it (aligning the two lakes' targets).
        toast.warning(
          `Nothing could be converged: ${data.crossLakeConflictCount} remaining file(s) belong to another ` +
            'data lake that requires a different passage target. Align the two lakes, or remove the files from one.'
        );
      } else {
        toast.success("Every measurable file already satisfies this lake's chunk policy.");
      }
      if (dataLakeId) {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.convergencePlan(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
        // A convergence wave mass-mutates the exact rollups health is computed from, and the health
        // query has no refetchInterval and does not refetch on focus - same reason the rebuild
        // mutation invalidates it explicitly. Also invalidated on the guard/refusal outcomes, which
        // enqueue nothing: harmless, and it keeps the invalidation set from depending on the branch.
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
      }
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to start convergence');
    },
  });
}

/**
 * Hook: Attach existing files to a data lake by toggling on its `datalake:*` meta-tag, through
 * the same `/api/files/tags/toggle` write every other manual membership join uses (see
 * toggleTags). Lets an owner add a file they already uploaded without re-uploading it through
 * the wizard.
 *
 * A dedicated add-only door DOES exist (`POST /api/data-lakes/:id/files/:fabFileId`, see
 * addFileToDataLake) - it mints a restore record and an audit row and is per-file, not batched.
 * This hook deliberately uses the shared toggle door instead, for the batch: `addFileToLake`
 * (which both doors ultimately call) now carries the same ownership conjunct
 * `addFileToDataLake`'s cold-add path applies, so the two doors' access decisions agree; what
 * this door does not get is the restore record or the per-write audit row.
 *
 * IMPORTANT: the toggle endpoint TOGGLES the tag, so this must only ever be called with ids that
 * are NOT already members - reposting the tag for an existing member would remove it (and its
 * content-prefix tags with it, unrecoverably). The caller (Files browser) filters the selection
 * down first; `skippedCount` is purely for the success toast's wording.
 */
export function useAddFilesToLake() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: async ({
      fileIds,
      lake,
      skippedCount = 0,
    }: {
      fileIds: string[];
      lake: { id: string; datalakeTag: string };
      skippedCount?: number;
    }) => {
      const res = await api.post<IFabFileDocument[]>('/api/files/tags/toggle', {
        ids: fileIds,
        tags: [lake.datalakeTag],
      });
      return { files: res.data, lake, skippedCount };
    },
    onSuccess: ({ files, skippedCount }) => {
      toast.success(
        skippedCount > 0
          ? t('file_browser.added_to_lake_with_skipped', { count: files.length, skippedCount })
          : t('file_browser.added_to_lake', { count: files.length })
      );
    },
    onError: (error: Error) => {
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      if (refusal) {
        toast.error(refusal);
        return;
      }
      toast.error(error.message || 'Failed to add files to the data lake');
    },
    // A mid-batch failure can still leave some of the batch's files written (toggleTags is not
    // transactional across files - see its docblock), so invalidation must run on every outcome,
    // not only success: an onSuccess-only invalidation left the cache reporting the pre-add state
    // after a partial failure, and the client's own non-member filter (Content.tsx) reads from
    // that same cache before the next attempt.
    onSettled: (_data, _error, { lake }) => {
      queryClient.invalidateQueries({ queryKey: ['fabFiles'] });
      invalidateLakeFileMembershipQueries(queryClient, lake.id);
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
  /**
   * The merged tree's Uncategorized bucket: lake members categorized under none of the caller's
   * lake prefixes. Sized by `totalUncategorizedFileCount` on the tag-counts payload. For ONE
   * lake's bucket use useGetDataLakeUncategorizedFiles - this route has no lake-scope parameter.
   */
  uncategorized?: boolean;
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
  /**
   * Same lakes as `lakeFileCounts`, split into the two membership arms so the manager can say
   * whose signal made a file a member: `metaCount` carries the lake's `datalake:*` tag,
   * `prefixOnlyCount` is a member solely via a `fileTagPrefix` content tag (no meta-tag). The two
   * are disjoint and sum to `lakeFileCounts[datalakeTag]`.
   */
  lakeArmCounts: Record<string, { metaCount: number; prefixOnlyCount: number }>;
  /**
   * The slice of `lakeFileCounts` a prefix-keyed tag tree has no branch for: members carrying
   * the lake's meta-tag but no tag under its `fileTagPrefix`. Same key, same predicate, so a
   * tree can render this as an "Uncategorized" bucket and account for every file the picker
   * advertises instead of showing a count it cannot list (#2031).
   */
  uncategorizedFileCounts: Record<string, number>;
  /**
   * Distinct live files across EVERY reachable lake, on the same membership basis as
   * `lakeFileCounts` - the number for an all-lakes row sitting above per-lake rows. Those rows
   * can still sum higher than this, since a file in two lakes counts for each; what they no
   * longer do is describe a different population than the total above them.
   *
   * Not `uniqueArticleCounts.total`, which is prefix-based: a lake whose files carry only the
   * meta-tag contributes 0 there while its own row reads its full size.
   */
  totalLakeFileCount: number;
  /**
   * The merged (all-lakes) tree's bucket: distinct members categorized under NO accessible
   * prefix. Not a sum of `uncategorizedFileCounts` - those judge each lake separately, so a file
   * categorized in lake A but not in lake B is reachable under A's branch and must not appear.
   */
  totalUncategorizedFileCount: number;
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
 * One lake's "Uncategorized" bucket: the members carrying no tag under the lake's own
 * `fileTagPrefix`, which is exactly what a prefix-keyed tag tree has no branch for. Fetched
 * lazily (the bucket row's COUNT comes from tag-counts, so nothing here is needed to render it)
 * and only once a caller opens the bucket - hence the explicit `enabled`.
 *
 * Separate from useDataLakeFiles rather than a param on it so the two cannot share a cache
 * entry: they hit the same route with different scopes and the same key would serve one for
 * the other.
 */
export function useGetDataLakeUncategorizedFiles(dataLakeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: dataLakeKeys.files(dataLakeId, { uncategorized: true }),
    queryFn: async () => {
      const response = await api.get<{ data: IFabFileDocument[]; total: number; hasMore: boolean }>(
        `/api/data-lakes/${dataLakeId}/articles`,
        { params: { uncategorized: 'true', limit: 100 } }
      );
      return response.data;
    },
    enabled: enabled && !!dataLakeId,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5,
  });
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
  return { ...query, isForbidden: isPermissionRejection(query.error) };
}

// ── Acquisition proposal queue (#1671) ──────────────────────────────────────

/**
 * One lake's acquisition review queue. Manage-gated server-side, so a mere reader gets a 4xx -
 * surfaced as `isForbidden` and never retried, matching `useDataLakeSpend`. Callers gate the whole
 * surface on that flag rather than painting an error.
 *
 * No polling: proposals arrive from a background producer, but a reviewer who has the panel open is
 * mid-decision, and a list that reshuffles under them is worse than one that is a few minutes stale.
 */
export function useDataLakeProposals(
  dataLakeId: string | null,
  status?: DataLakeProposalStatus,
  opts?: { enabled?: boolean }
) {
  const query = useQuery({
    queryKey: dataLakeKeys.proposals(dataLakeId, status),
    queryFn: async () => {
      const { data } = await api.get<{ data: IDataLakeProposalDocument[] }>(`/api/data-lakes/${dataLakeId}/proposals`, {
        params: status ? { status } : undefined,
      });
      return data.data;
    },
    enabled: !!dataLakeId && (opts?.enabled ?? true),
    retry: false,
    // Refetch on focus, unlike the rest of this file: a reviewer keeps this panel open while opening
    // sources in other tabs, and coming back to a queue that silently no longer matches the database
    // is how you decline something a colleague already ruled on. Cheap - one small read of one lake's
    // pending rows, and only while a manager has the modal open.
    refetchOnWindowFocus: true,
    // Short enough that returning to the tab shows the real queue, long enough that tab-flipping
    // within a single review pass does not refetch on every switch.
    staleTime: 1000 * 15,
  });
  return { ...query, isForbidden: isPermissionRejection(query.error) };
}

/**
 * The server's own refusal text for a failed review decision, or a fallback.
 *
 * Shared by the toast and the card's inline alert so the two can never disagree about what went
 * wrong. The body key is `error`, per server/middlewares/errorHandler.ts - reading `message` (as
 * this once did) matched nothing, so the fallback always won and the messages that matter most
 * ("already been reviewed", "the source returned HTTP 404") never reached the reviewer.
 */
export function reviewProposalFailureMessage(error: unknown): string {
  const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
  return refusal || 'Could not record that decision. Try again shortly.';
}

/**
 * Approve or decline one proposal. An approval admits the source into the lake through the ordinary
 * ingestion door, so it invalidates the lake's file list and health alongside the queue - the file
 * appears immediately, and its health badge stops reflecting a corpus that just changed.
 */
export function useReviewDataLakeProposal(dataLakeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      proposalId,
      decision,
      reason,
    }: {
      proposalId: string;
      decision: 'approve' | 'decline';
      reason?: string;
    }) => {
      const { data } = await api.post<{ data: IDataLakeProposalDocument }>(
        `/api/data-lakes/${dataLakeId}/proposals/${proposalId}`,
        { decision, reason }
      );
      return data.data;
    },
    onSuccess: (proposal, { decision }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.proposalsOf(dataLakeId) });
      if (decision === 'approve') {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesOf(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
      }
      toast.success(decision === 'approve' ? `Added "${proposal.title}" to the lake` : 'Proposal declined');
    },
    onError: (error: unknown) => {
      toast.error(reviewProposalFailureMessage(error));
    },
  });
}
