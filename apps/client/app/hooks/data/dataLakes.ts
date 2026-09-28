import type {
  BrowsePublicDataLakesResult,
  DataLakeAccessRole,
  DataLakeConfig,
  DataLakeDocumentPurgeReceipt,
  DataLakeMembershipArm,
  DataLakeProposalStatus,
  IDataLakeProposalDocument,
  IDataLakeResearchConfigDocument,
  IDataLakeResearchRunDocument,
  ResearchRunTrigger,
  IDataLakeBatchDocument,
  IDataLakeBatchSummary,
  IDataLakeFindingDocument,
  InconsistencyKind,
  LakeInconsistencyScanSummary,
  LakeFindingStatus,
  IDataLakeSpendResponse,
  IFabFileDocument,
  DataLakePrincipalType,
  LakeAccessView,
  LakeOwnershipCandidateList,
  LakeOwnershipOfferSummary,
  LakePendingOwnershipOffer,
  LakeHealthApiResponse,
  LakeMemoryHealth,
  LakeConfigHistoryView,
  ManageableDataLakeConfig,
  TaxonomyTag,
  TransitionalDataLakeSummary,
  TransitionalRetryAction,
} from '@bike4mind/common';
import { isAxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import {
  BATCH_NON_TERMINAL_STATUSES,
  DATA_LAKES,
  isResearchRunInFlight,
  normalizeTagPrefix,
  tagPrefixesOverlap,
  TAXONOMY_NON_TERMINAL_STATUSES,
} from '@bike4mind/common';
import type {
  CreateDataLakeRequestInputType,
  DuplicateBucket,
  RepairDecision,
  SourceIdentityTier,
  MembershipRepairPlanRead,
  UpdateDataLakeRequestInputType,
  UpdateFallbackLakeSettingsRequestInputType,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { invalidateGearsStatusWhileLocked } from '@client/app/hooks/useGearsStatus';
import { dataLakeKeys } from '@client/app/hooks/data/dataLakeKeys';
import { fabFileKeys } from '@client/app/hooks/data/fabFileKeys';

/**
 * The server's own refusal text, if it sent one. The body key is `error`, per
 * server/middlewares/errorHandler.ts - every data-lake surface that shows a refusal to a human
 * reads it through here so none of them can drift back onto `message` and silently show only
 * their fallback.
 *
 * Why this matters on every mutation below: axios rejects with `.message` set to the generic
 * "Request failed with status code 400", so a handler that toasts `error.message` discards the
 * one sentence that tells the user what to do about it. These doors refuse for reasons the user
 * can act on - "choose a different prefix", "Make it private first", "try again" - and a status
 * code is the single least useful thing to show instead.
 *
 * Declared here rather than beside its first caller so all of them can read it without a
 * forward reference.
 */
function serverRefusalMessage(error: unknown): string | undefined {
  if (!isAxiosError(error)) return undefined;
  return (error.response?.data as { error?: string } | undefined)?.error || undefined;
}

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
 * The lake list with `canPreauthorize` resolved against `userId` instead of the caller (#2945).
 * Admin-only server-side; the route 403s a non-admin that asks.
 *
 * For the admin key-mint picker: `POST /api/admin/users/[userId]/generate-api-key` screens a
 * requested binding against the TARGET user's manage rung, so a picker built on the caller's own
 * labels offers lakes that route then rejects with a 400. Filter the result on `canPreauthorize`,
 * never on `canManage` - platform admin is `canManage: true` on every lake and a rung on none.
 */
export function useGetPreauthorizableDataLakes(userId: string, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.preauthorizableFor(userId),
    enabled: enabled && !!userId,
    retry: false,
    queryFn: async () => {
      const response = await api.get<{ data: ManageableDataLakeConfig[] }>(
        `/api/data-lakes?preauthorizableFor=${encodeURIComponent(userId)}`
      );
      return response.data.data;
    },
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 2,
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
 * One lake's unanswered duplicate groups (#2238): the same document held twice, narrowed to the
 * groups no ruling has settled. The read the duplicate chip and its dialog render.
 *
 * A separate read from `useGetDataLakeHealth` rather than a slice of it, matching the routes: health
 * is readable by anyone who can read the lake and is blind to rulings, while this is manage-gated and
 * suppresses what an owner has already answered. `enabled` is how a caller declines to ask on a lake
 * it knows it cannot manage - a mere reader gets a 4xx, and like the other manage-gated reads it does
 * not retry that.
 */
export function useGetLakeMembershipDuplicates(dataLakeId: string | null, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.membershipDuplicates(dataLakeId ?? ''),
    enabled: enabled && !!dataLakeId,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 2,
    queryFn: async () => {
      const response = await api.get<MembershipRepairPlanRead>(`/api/data-lakes/${dataLakeId}/membership-duplicates`);
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
      const response = await api.get<{
        data: LakeAccessView;
        meta?: { canTransferOwnership?: boolean; readerGrantsEnforced?: boolean };
      }>(`/api/data-lakes/${dataLakeId}/access`);
      // The capability is kept OUT of the view object it sits beside: the view is the artifact the CSV
      // export mirrors, and a per-viewer permission is not a fact about the lake's access.
      // Fails closed - an older server that omits `meta` hides the control rather than showing one
      // whose action would 400. `readerGrantsEnforced` fails closed the other way round, and for the
      // same reason: absent, the UI keeps the "recorded but not yet in force" disclosure rather than
      // quietly dropping it.
      return {
        view: response.data.data,
        canTransferOwnership: response.data.meta?.canTransferOwnership === true,
        readerGrantsEnforced: response.data.meta?.readerGrantsEnforced === true,
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
      const response = await api.get<{
        data: LakeOwnershipCandidateList;
        pendingOffer: LakePendingOwnershipOffer | null;
      }>(`/api/data-lakes/${dataLakeId}/transfer-ownership`);
      // The pending offer arrives beside the candidate list, not inside it (the server keeps them
      // separate facts); merge it here so the dialog reads one object.
      return { ...response.data.data, pendingOffer: response.data.pendingOffer ?? null };
    },
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

/**
 * Offer a lake's ownership to another user. BREAKING: this no longer transfers anything - it opens a
 * PENDING OFFER the recipient must accept, and ownership is unchanged until they do. The prior owner
 * therefore keeps every owner power in the meantime.
 *
 * Invalidates the picker's own query (the pending offer is read from it) and the access view, so the
 * dialog that just sent the offer re-renders in its "waiting on X" state.
 */
export function useTransferLakeOwnership() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, newOwnerUserId }: { id: string; newOwnerUserId: string }) => {
      const response = await api.post<{ offer: unknown }>(`/api/data-lakes/${id}/transfer-ownership`, {
        newOwnerUserId,
      });
      return response.data;
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipCandidates(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(id) });
      toast.success('Ownership offer sent');
    },
    onError: (error: Error, { id }) => {
      // A refusal can be the stale-state kind ("already has a pending offer", "the member list
      // changed"): refetch so the dialog shows what the server sees instead of dead controls.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipCandidates(id) });
      // This endpoint's rejections are the actionable kind ("name another member", "must belong to
      // the organization that owns this data lake").
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || 'Failed to send the ownership offer');
    },
  });
}

/** Cancel a pending offer before the recipient answers. Nothing was transferred, so nothing unwinds. */
export function useCancelLakeOwnershipOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const response = await api.delete<{ offer: unknown }>(`/api/data-lakes/${id}/transfer-ownership`);
      return response.data;
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipCandidates(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(id) });
      toast.success('Ownership offer cancelled');
    },
    onError: (error: Error, { id }) => {
      // A cancel that loses a race (the recipient already accepted) 404s; refetch so a stale "Cancel
      // offer" button that can never succeed is replaced by the real state.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipCandidates(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(id) });
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || 'Failed to cancel the ownership offer');
    },
  });
}

/**
 * The caller's own pending ownership offers - the recipient's banner. No id to pass: the server scopes
 * the query to the authenticated user.
 */
export function useOwnLakeOwnershipOffers(enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.ownershipOffers,
    enabled,
    retry: false,
    queryFn: async () => {
      const response = await api.get<{ data: LakeOwnershipOfferSummary[] }>('/api/data-lakes/ownership-offers');
      return response.data.data;
    },
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

/**
 * Accept an offer and take ownership. Invalidate the lake list and the access view as well as the
 * offers themselves: the accept changes what the caller can MANAGE, and records a config-change row,
 * so the panel's own controls and the History tab must both refetch.
 */
export function useAcceptLakeOwnershipOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ offerId }: { offerId: string; dataLakeId: string }) => {
      const response = await api.post<{ data: { newOwnerUserId: string; demotedUserIds: string[] } }>(
        `/api/data-lakes/ownership-offers/${offerId}/accept`
      );
      return response.data.data;
    },
    onSuccess: (_data, { dataLakeId }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipOffers });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(dataLakeId) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(dataLakeId) });
      toast.success('Data lake ownership transferred');
    },
    onError: (error: Error, { dataLakeId }) => {
      // A failed accept (expired, stale, withdrawn) means the banner's list is out of date; refetch it
      // and the lake so the recipient is not left staring at an offer the server has already closed.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipOffers });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(dataLakeId) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(dataLakeId) });
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || 'Failed to accept the ownership offer');
    },
  });
}

/** Decline an offer. Touches no grants, so only the offers list needs refreshing. */
export function useDeclineLakeOwnershipOffer() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ offerId }: { offerId: string }) => {
      const response = await api.post<{ data: { id: string; status: string } }>(
        `/api/data-lakes/ownership-offers/${offerId}/decline`
      );
      return response.data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipOffers });
      toast.success('Ownership offer declined');
    },
    onError: (error: Error) => {
      // The offer may already be gone (cancelled, or accepted elsewhere); refresh the banner so it
      // stops showing an offer the server will refuse.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.ownershipOffers });
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || 'Failed to decline the ownership offer');
    },
  });
}

/** A grant request: the principal by id or (for a user) by email, plus the role and any expiry. */
export interface GrantLakeAccessBody {
  principalType: DataLakePrincipalType;
  principalId?: string;
  principalEmail?: string;
  role: DataLakeAccessRole;
  expiresAt?: string | null;
}

export interface RevokeLakeAccessBody {
  principalType: DataLakePrincipalType;
  principalId: string;
}

/**
 * Grant a principal access to one lake, or re-role the grant they already hold. The routine sharing
 * door: `owner` is refused by the server (ownership moves only through transfer), so the form does
 * not offer it.
 *
 * Invalidates the lake list as well as the access view and the config history: the actor can target
 * THEMSELVES (the form takes any email, their own included), so re-roling themselves down drops
 * their own manage rung while `canManage` on the cached list still says otherwise - Settings and
 * Access would stay lit until something else refetched and then 403. Same reasoning as
 * `useTransferLakeOwnership`. The history goes too because this door records a config-change event.
 */
export function useGrantLakeAccess() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...body }: { id: string } & GrantLakeAccessBody) => {
      const response = await api.post<{ data: { principalId: string; role: DataLakeAccessRole } }>(
        `/api/data-lakes/${id}/grants`,
        body
      );
      return response.data.data;
    },
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      toast.success('Access granted');
    },
    onError: (error: Error) => {
      // Surface the server's own refusal text: every rejection on this door is the actionable kind
      // ("use transfer ownership instead", "only be shared with the organization that owns it",
      // "no account was found for that email address"), and axios would replace them all with
      // "Request failed with status code 400". Body key is `error` (server/middlewares/errorHandler.ts).
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(refusal || error.message || 'Failed to grant access');
    },
  });
}

/** Revoke a principal's grant on a lake. The server refuses an ownership grant, so rows holding one
 * do not offer this.
 *
 * Invalidates the list and the config history alongside the access view, for the same reasons as
 * `useGrantLakeAccess`: the revoked principal may be the actor, and the door records an audit event. */
export function useRevokeLakeAccess() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, principalType, principalId }: { id: string } & RevokeLakeAccessBody) => {
      const response = await api.delete<{ data: { revoked: boolean } }>(`/api/data-lakes/${id}/grants`, {
        params: { principalType, principalId },
      });
      return response.data.data;
    },
    onSuccess: (data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.access(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      // `revoked: false` means the grant was already gone - the outcome asked for, so not an error,
      // but saying "revoked" would claim this call did something it did not. Naming the race is what
      // keeps it from reading as "your revoke failed": the caller's own double-click can no longer
      // land here (the confirm dialog disables while in flight), so another manager got there first.
      toast.success(
        data.revoked ? 'Access revoked' : 'That principal already had no access - someone else may have revoked it'
      );
    },
    onError: (error: Error) => {
      const refusal = isAxiosError(error) ? (error.response?.data as { error?: string } | undefined)?.error : undefined;
      toast.error(refusal || error.message || 'Failed to revoke access');
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to create data lake');
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to update data lake');
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
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
      // This door records an `update` config-change event too, same as useUpdateDataLake. Inert
      // while the only caller is FallbackLakeSettingsModal, which does not mount the History
      // section - kept for the same rule the other config doors follow.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
      toast.success('Data lake settings updated');
    },
    onError: (error: Error) => {
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to update data lake settings');
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to change visibility');
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

type LifecycleAction = 'archive' | 'unarchive' | 'restore' | 'delete' | 'cleanup' | 'promote' | 'demote';

async function postLifecycle(id: string, action: LifecycleAction) {
  const response = await api.post(`/api/data-lakes/${id}/lifecycle`, { action });
  return response.data;
}

/**
 * Every cache key a settled lifecycle move invalidates. Shared by the fixed-action hooks and the
 * status-driven retry so the two cannot drift - a retry settles a lake exactly as the original
 * action would have, so it must refresh exactly the same surfaces.
 */
function invalidateAfterLifecycle(queryClient: ReturnType<typeof useQueryClient>, id: string) {
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.list });
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.archived });
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.deleted });
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.transitional });
  // A lifecycle move changes what is BROWSABLE, not just which lakes are listed: archiving
  // stamps archivedAt on the lake's files, which both tag counters exclude. Without this the
  // lake list and the tag tree disagree - the page's lake rail (sourced from `list`) drops the
  // row while the tree beside it still shows that lake's branches and counts it in the totals.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
  // Every lifecycle action records a config-history row. Invalidated for all four rather than only
  // the reversible ones: after a delete the history observer is already unmounted, so the extra key
  // is inert, and enumerating which actions qualify would rot as actions are added. Four, not five:
  // `cleanup` never reaches this helper - the purge door builds its own onSuccess around the
  // pending-purge suppression, and invalidates this same key itself.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
  // The health report's serving verdict is derived from `lake.status` (computeLakeHealth), so
  // every lifecycle move changes it - publish flips "Not serving: draft" to serving. The query
  // neither polls nor refetches on focus, so without this the chip holds the pre-move verdict.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(id) });
}

function useLifecycleMutation(action: LifecycleAction, successMessage: string, errorMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postLifecycle(id, action),
    onSuccess: (_data, id) => {
      invalidateAfterLifecycle(queryClient, id);
      toast.success(successMessage);
    },
    onError: (error: Error) => {
      toast.error(serverRefusalMessage(error) || error.message || errorMessage);
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

/**
 * Publishes a draft lake - the explicit, owner/admin-only replacement for the old implicit
 * draft -> active flip. A draft lake is excluded from grounding until this runs.
 */
export function usePromoteDataLake() {
  return useLifecycleMutation('promote', 'Data lake published', 'Failed to publish data lake');
}

/** Moves an active lake back to draft, pulling it out of grounding. Reverses promote. */
export function useDemoteDataLake() {
  return useLifecycleMutation('demote', 'Data lake moved back to draft', 'Failed to move data lake back to draft');
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
      //
      // The history IS invalidated, and safely: ['dataLakeConfigHistory', id] does not prefix-match
      // the deleted list, so it cannot undo the removal above. Inert in today's UI - a purge is
      // accepted from the Deleted section, with the lake's History observer unmounted - and kept
      // anyway for the rule `invalidateAfterLifecycle` already states: every door whose write can
      // record a config-history row invalidates that lake's history, rather than each door
      // re-deciding whether its row is currently observable. `purge` is the entry that rule can
      // least afford to skip - it is the only audit record a purge leaves behind.
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.configHistoryOf(id) });
      toast.success('Data lake permanently purged');
    },
    onError: (error: Error) => {
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to clean up data lake');
    },
  });
}

/**
 * Lists lakes stranded mid-lifecycle (needs-attention view). The server already scopes this to
 * lakes the caller can MANAGE and withholds ones still inside the staleness cutoff, so every row
 * this returns is one the caller can actually act on.
 */
export function useGetTransitionalDataLakes(enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.transitional,
    enabled,
    queryFn: async () => {
      const response = await api.get<{ data: TransitionalDataLakeSummary[] }>('/api/data-lakes/transitional');
      return response.data.data;
    },
  });
}

/**
 * Re-runs the lifecycle action that settles a stranded lake. Not a repair path: each lifecycle
 * service re-admits its own transitional status for exactly this crash re-entry, so this posts the
 * SAME action that stranded the lake.
 *
 * Takes the action, not the status: the server resolved it (see `resolveRetryAction`, which for
 * `restoring` reads sweep marks this view does not carry), and a row whose DTO names no action
 * must not offer Retry at all.
 */
export function useRetryLakeLifecycle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: TransitionalRetryAction }) => postLifecycle(id, action),
    onSuccess: (_data, { id }) => {
      invalidateAfterLifecycle(queryClient, id);
      toast.success('Retrying the data lake operation');
    },
    onError: (error: Error) => {
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to retry the data lake operation');
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

/** Fast cadence while a batch in the list is still moving; see activeBatchesPollInterval. */
export const ACTIVE_BATCHES_POLL_MS = 10_000;

/** Never false: a batch can start outside this tab (Slack, Drive, research, another tab), and the
 * GET drives server-side stuck-batch reconciliation. */
export const IDLE_BATCHES_POLL_MS = 60_000;

/**
 * Fast only while ingest or AI-tagging is non-terminal; a batch waiting on review or failed can
 * sit for days, so it must not hold the fast cadence.
 */
export function activeBatchesPollInterval(batches: IDataLakeBatchSummary[] | undefined): number {
  const isMoving = (b: IDataLakeBatchSummary) =>
    BATCH_NON_TERMINAL_STATUSES.includes(b.status) ||
    (!!b.taxonomyStatus && TAXONOMY_NON_TERMINAL_STATUSES.includes(b.taxonomyStatus));
  return batches?.some(isMoving) ? ACTIVE_BATCHES_POLL_MS : IDLE_BATCHES_POLL_MS;
}

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
    refetchInterval: query => (enabled ? activeBatchesPollInterval(query.state.data) : false),
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
      const res = await api.post<{
        success: true;
        filesUpdated: number;
        // `unchanged` and `skipped` shipped in the SAME service commit, so a server predating it
        // omits both - a type marking only one optional describes a payload that never existed.
        unchanged?: number;
        // Files whose optimistic-concurrency check lost - something else changed their tags between
        // the read and the write, or the file was deleted inside the window.
        skipped?: number;
      }>(`/api/data-lakes/batches/${batchId}/apply-taxonomy`, { tags });
      return res.data;
    },
    onSuccess: result => {
      // A re-apply that changes nothing reported "Tags applied to N files" - every file counted as
      // updated, because the identical-value write still bumped `updatedAt`. Splitting `unchanged`
      // out is what stops that over-report.
      const plural = (n: number) => `${n.toLocaleString()} file${n === 1 ? '' : 's'}`;
      // Defaulted once, so an old server's absent fields read as zero everywhere below rather than
      // needing a `??` (or a `!`) at each use.
      const unchanged = result.unchanged ?? 0;
      const skipped = result.skipped ?? 0;
      const applied =
        result.filesUpdated === 0 && unchanged === 0
          ? skipped === 0
            ? // Reachable: a batch where no file matches any accepted tag emits no ops and counts no
              // `unchanged`. "Tags applied to 0 files" was the last arm claiming something happened.
              'No files matched these tags'
            : // Every op the batch emitted lost its CAS race. Files DID match, so "no files matched"
              // contradicts the skipped clause below, and falling through to the next arm would say
              // "already up to date on 0 files" instead - worse. That clause is the whole story
              // here, so contribute no prefix to it.
              ''
          : result.filesUpdated === 0
            ? `Tags already up to date on ${plural(unchanged)}`
            : unchanged > 0
              ? `Tags applied to ${plural(result.filesUpdated)}, ${plural(unchanged)} already up to date`
              : `Tags applied to ${plural(result.filesUpdated)}`;
      // Read `skipped` FIRST: "already up to date on 7 files" is an affirmative claim of
      // completeness, and it would otherwise fire unchanged on a batch where the other 3 files
      // silently failed their CAS check. Warning rather than success, because nothing in the
      // product lets the user retry a batch once it is 'applied'.
      if (skipped > 0) {
        const detail = `${plural(skipped)} could not be updated - changed while applying.`;
        toast.warning(applied ? `${applied}. ${detail}` : detail);
      } else {
        // `applied` is only ever empty on the all-skipped arm above, which cannot reach here.
        toast.success(applied);
      }
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.activeBatches });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.filesRoot });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.tagCountsRoot });
    },
    onError: (error: Error) => {
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to apply tag suggestions');
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to re-analyze tags');
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to dismiss tag suggestions');
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
 *
 * Sends `dataLakeId` so a lake manager who is not the file's uploader is authorized on their manage
 * rights over THIS lake rather than on ownership of the file (#3167). The route falls back to the
 * caller's own rights when it is absent, so this is additive: it never narrows what an owner can do.
 */
export function useReprocessFabFile(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (fabFileId: string) => {
      const res = await api.post<{ messageId: string }>('/api/files/reprocess', {
        fabFileId,
        // Omitted rather than sent as null: the server reads its presence as "act under this lake's
        // authority", and a null would have to be special-cased at every read of it.
        ...(dataLakeId ? { dataLakeId } : {}),
      });
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to re-process file');
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
  // Adding or removing a member can open a duplicate group or empty one out (#2238).
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.membershipDuplicates(dataLakeId) });
  // A membership change can move the lake's under-chunked count, so refresh the rebuild badge.
  queryClient.invalidateQueries({ queryKey: dataLakeKeys.rebuildStatus(dataLakeId) });
  // A membership write records no config-history row of its own any more (publishing moved to
  // the explicit promote door), but it is invalidated anyway for the same reason the lifecycle
  // hook does it: the cost is nothing, and reasoning about which paths qualify is what rots.
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
      // Every actionable rejection on this door lands here - "You do not have permission to add
      // files to this data lake", "Data lake not found", the built-in-lake refusal - and this is
      // the toast the non-owner confirmation copy calls their only way back, so a status string is
      // the one message that cannot help them.
      const refusal = serverRefusalMessage(error);
      const message = refusal || error.message || 'Failed to restore the file to the data lake';
      toast.error(message, toastId !== undefined ? { id: toastId } : undefined);
    },
  });
}

/**
 * Hook: record the owner's answer to "this lake already holds this document" and carry it out
 * (#2238). The question is raised by the same-identity check at the post-chunk admission
 * checkpoint; this is the answer.
 *
 * `keep-newest` removes the older copies through the ordinary lake-scoped removal door, so the file
 * survives in its owner's Files list and in every other lake, and the server mints the same
 * short-TTL restore record every removal does. `keep-both` records the ruling and removes nothing,
 * so a later repair run does not re-ask about a pair the owner deliberately kept. Cancelling is not
 * an answer, so there is nothing to send for it - the caller simply closes the dialog.
 *
 * Offers Undo on the replacement toast for the same reason `useRemoveFileFromDataLake` does, and
 * SPENDS the same records: `removedFabFileIds` names every member the ruling removed, and each one
 * carries a short-TTL restore record on the server. That toast is the only affordance that can spend
 * them (see UNDO_TOAST_DURATION_MS), and the dialog's copy promises it, so a plain success toast
 * here would have made a destructive action irreversible for a non-owner in practice.
 *
 * Invalidates through `invalidateLakeFileMembershipQueries` rather than a bespoke list, because a
 * `keep-newest` genuinely IS a membership change and stales exactly what a removal stales.
 */
export interface MembershipDecisionVariables {
  dataLakeId: string;
  fileName: string;
  decision: RepairDecision;
  /** Required for `keep-specific` and rejected for anything else - the server enforces both. */
  keptFabFileId?: string | null;
}

export interface MembershipDecisionResponse {
  success: true;
  fileName: string;
  decision: RepairDecision;
  tier: SourceIdentityTier;
  bucket: DuplicateBucket;
  removedFabFileIds: string[];
}

export function useRecordMembershipDecision() {
  const queryClient = useQueryClient();
  const addFileToDataLake = useAddFileToDataLake();
  return useMutation({
    mutationFn: async ({ dataLakeId, fileName, decision, keptFabFileId }: MembershipDecisionVariables) => {
      const res = await api.post<MembershipDecisionResponse>(`/api/data-lakes/${dataLakeId}/membership-decisions`, {
        fileName,
        decision,
        ...(keptFabFileId ? { keptFabFileId } : {}),
      });
      return res.data;
    },
    onSuccess: (data, { dataLakeId }) => {
      invalidateLakeFileMembershipQueries(queryClient, dataLakeId);

      const removed = data.removedFabFileIds;
      if (removed.length === 0) {
        // "every copy", not "both": a group of three is routine (the duplicated corpus this lane
        // came from held several generations of one name), and there is nothing to undo here.
        toast.success(`Kept every copy of "${data.fileName}". You will not be asked again unless they change.`);
        return;
      }

      const toastId = toast.success(
        `Replaced: ${removed.length} older ${removed.length === 1 ? 'copy' : 'copies'} of ` +
          `"${data.fileName}" left this lake.`,
        {
          duration: UNDO_TOAST_DURATION_MS,
          action: {
            label: 'Undo',
            onClick: () => {
              // One restore per removed member, and no per-call callbacks: this click routinely
              // happens after the dialog holding the hook has unmounted, which is exactly when those
              // are dropped. Every restore addresses THIS toast, so the last one to land - a success
              // or a refusal - is what the manager is left reading. Sequential ordering is not
              // needed: the restores are independent lake writes over distinct files.
              for (const fabFileId of removed) {
                addFileToDataLake.mutate({ dataLakeId, fabFileId, toastId });
              }
            },
          },
        }
      );
    },
    onError: (error: Error) => {
      // "You do not have permission to resolve duplicates in this data lake" and "That file name no
      // longer has duplicate members in this data lake" are both actionable.
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || 'Failed to record the decision');
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
      const refusal = serverRefusalMessage(error);
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
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
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || 'Failed to permanently delete this file');
    },
  });
}

export type LakeRebuildStatus = {
  underChunkedCount: number;
  failedCount: number;
  /**
   * Members retrieval is withholding for being embedded in a previous embedding space, or `null`
   * when the server could not resolve the space to compare against. Null is deliberately NOT 0: it
   * covers a deployment with no usable embedding model AND a rolling-deploy skew against a server
   * that predates this field, and in both the honest answer is "no count", not "nothing to do".
   */
  staleEmbeddingSpaceCount: number | null;
  /**
   * Whether the server could resolve an embedding space at all, or `null` when it did not say - an
   * older server omits the field, which is the rolling-deploy skew and must stay silent. `false` is
   * a configuration state that persists until an operator changes it (a self-host with no usable
   * provider credential has no keyless fallback), not a window that closes on its own.
   */
  embeddingSpaceResolved: boolean | null;
};

/** Extra polls after the backlog clears, at SETTLE_MS each - about three minutes of cover. */
const REBUILD_SETTLE_POLLS = 18;
const REBUILD_SETTLE_MS = 10_000;

export type RebuildPollState = { sawBacklog: boolean; settlePolls: number };
export const INITIAL_REBUILD_POLL_STATE: RebuildPollState = { sawBacklog: false, settlePolls: 0 };

/**
 * The REPAIRABLE work outstanding on a lake: both counts that drain to zero as waves complete.
 * Pure and exported for the same reason `nextRebuildPoll` is - it decides when the badge stops
 * polling, and a closure inside the hook is not executed by anything.
 *
 * A re-embed is normally run on a lake whose under-chunked count is already zero, so summing is
 * what keeps the badge alive for that wave rather than going quiet the moment it starts. A `null`
 * stale count contributes nothing: unknown is not a backlog, and polling on it would never end.
 */
export const rebuildBacklog = (
  status?: Pick<LakeRebuildStatus, 'underChunkedCount' | 'staleEmbeddingSpaceCount'>
): number => (status?.underChunkedCount ?? 0) + (status?.staleEmbeddingSpaceCount ?? 0);

/**
 * Poll cadence for the rebuild badge, as a pure function so it can be tested without mounting the
 * hook (the two defects this logic has carried both shipped because nothing executed it).
 *
 * `backlog` is the sum of the two REPAIRABLE counts - under-chunked and stale-embedding-space -
 * because each drains to zero on its own as waves complete. `failedCount` deliberately is NOT in
 * it: a failed file never retries (see countFailedFilesByScope - it is invisible to both the
 * detection query and the rescue sweep), so including it gives a term that can never reach zero and
 * the badge polls forever on any lake holding one. But the counts alone stop too early: they drop
 * the instant a wave is RESET, minutes before those chunk jobs finish, and a job that then fails
 * surfaces only in failedCount. So once the backlog clears we keep polling a bounded number of
 * extra times to catch that, then stop for good.
 */
export function nextRebuildPoll(
  backlog: number,
  prev: RebuildPollState
): { interval: number | false; next: RebuildPollState } {
  if (backlog > 0) {
    const interval = backlog > 200 ? 30_000 : backlog > 50 ? 15_000 : 5_000;
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
      return {
        underChunkedCount: res.data.underChunkedCount,
        failedCount: res.data.failedCount ?? 0,
        // `?? null`, not `?? 0`: an older server omits the field entirely, and defaulting that to a
        // zero would advertise "no stale files" on a lake nobody has measured.
        staleEmbeddingSpaceCount: res.data.staleEmbeddingSpaceCount ?? null,
        // Same reason, and `?? null` is load-bearing here too: absent is not `false`.
        embeddingSpaceResolved: res.data.embeddingSpaceResolved ?? null,
      };
    },
    enabled: enabled && !!dataLakeId,
    // Tick down as waves complete; coarser cadence while the backlog is large (each poll is a full
    // lake rescan), then a bounded settle window before going quiet. See nextRebuildPoll.
    refetchInterval: query => {
      const { interval, next } = nextRebuildPoll(rebuildBacklog(query.state.data), pollState.current);
      pollState.current = next;
      return interval;
    },
  });
}

/** Which population a rebuild wave drains. Absent means the under-chunked default, matching the
 *  server's own default so an older caller keeps its behaviour. */
export type LakeRebuildSelector = 'under-chunked' | 'stale-embedding-space';

export type RechunkVariables = { limit?: number; select?: LakeRebuildSelector } | undefined;

/**
 * Hook: re-chunk a bounded wave of the lake's files. `select` chooses the population - the legacy
 * oversized passages, or the members still embedded in a previous embedding space, which retrieval
 * withholds entirely. Server picks worst-first and caps the wave; call again (the badge shows
 * `remaining`) to drain the rest.
 */
export function useRechunkDataLake(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: RechunkVariables) => {
      const body = { ...(vars?.limit ? { limit: vars.limit } : {}), ...(vars?.select ? { select: vars.select } : {}) };
      const res = await api.post<{
        detected: number;
        enqueued: number;
        remaining: number;
        // Present only on the refusal arm. Typed optional because the success arm omits it entirely,
        // and read FIRST below: a paused run also returns `enqueued: 0`, which is indistinguishable
        // from "nothing to do" on the counts alone. The other refusal, an unresolvable embedding
        // space, is a 409 and so arrives in onError instead.
        outcome?: 'paused';
      }>(`/api/data-lakes/${dataLakeId}/rechunk`, body);
      return res.data;
    },
    onSuccess: (data, vars) => {
      if (data.outcome === 'paused') {
        // A warning, not a success: the server refused and changed nothing. Without this arm the
        // refusal fell through to "All files are already chunked into passages" as a GREEN success -
        // which is not merely uninformative but false, since the gate only runs when at least one
        // file was detected. Wording mirrors useConvergeDataLake's paused arm below.
        toast.warning(
          'Background lake work is paused, so nothing was rebuilt. No files were changed - re-run this ' +
            'once an administrator turns convergence back on.'
        );
      } else if (vars?.select === 'stale-embedding-space') {
        // Worded for what this wave actually does. "Rebuilding into passages" would be wrong here:
        // the files are already correctly chunked, and what changes is the vector space they are
        // searchable in - which is also why the unsearchable window is stated.
        //
        // Three arms, not two, and the reassuring one keys on `detected` rather than `enqueued`.
        // `enqueued` is the wave MINUS the sends that failed and the files a worker already held,
        // and the reset drops a wave's passages before any send can fail - so a run whose sends all
        // failed answers 200 with `enqueued: 0` on a non-empty `detected`, and the two-arm form told
        // the owner the lake was clean at the one moment it had just been emptied. Only
        // `detected === 0` means there was nothing to do.
        if (data.enqueued > 0) {
          toast.success(
            `Re-embedding ${data.enqueued} file(s) into the current embedding space - ${data.remaining} ` +
              'remaining. They are unsearchable until re-indexing completes.'
          );
        } else if (data.detected > 0) {
          toast.warning(
            `${data.detected} file(s) need re-embedding but none were queued - either a worker already ` +
              'has them, or the queue rejected them. Any the queue rejected are unsearchable until a ' +
              're-run succeeds.'
          );
        } else {
          toast.success('Every file in this lake is already in the current embedding space.');
        }
      } else if (data.enqueued > 0) {
        toast.success(`Rebuilding ${data.enqueued} file(s) into passages - ${data.remaining} remaining.`);
      } else if (data.detected > 0) {
        toast.warning(
          `${data.detected} file(s) need rebuilding but none were queued - either a worker already has ` +
            'them, or the queue rejected them. Re-run this if the count does not fall.'
        );
      } else {
        toast.success('All files are already chunked into passages.');
      }
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to start rebuild');
    },
  });
}

/**
 * Wire shape of `LakeMemoryHealth`: `lastBuiltAt` crosses JSON as an ISO string, not a Date.
 */
export type LakeMemoryHealthResponse = Omit<LakeMemoryHealth, 'lastBuiltAt'> & { lastBuiltAt: string | null };

export const LAKE_MEMORY_POLL_MS = 5_000;

/**
 * Poll cadence for the lake-memory build door. Exported and pure for the same reason
 * `nextRebuildPoll` is: an inline poll predicate is executed by nothing in a test, so a bug in it
 * ships green.
 *
 * Keys off `running` - a lease actually held - and NOT `state === 'building'`, which is also true for
 * a parked continuation cursor. That distinction is the whole termination argument: a cursor left by
 * a chain that ended unfinished never changes on its own, so polling `building` meant a tick every
 * 5s for as long as the panel stayed open, against a state nothing was going to move. A lease, by
 * contrast, either expires or is released.
 */
export function lakeMemoryPollInterval(data: Pick<LakeMemoryHealthResponse, 'running' | 'state'> | undefined) {
  return data?.running ? LAKE_MEMORY_POLL_MS : (false as const);
}

/**
 * The manual build door's own state (GET /api/data-lakes/:id/lake-memory) - kept separate
 * from the whole-lake /health report so the UI can poll it while a build runs without paying for
 * health's per-file member scan on every tick. Cadence in `lakeMemoryPollInterval`.
 */
export function useGetLakeMemoryHealth(dataLakeId: string | null, enabled = true) {
  return useQuery({
    queryKey: dataLakeKeys.lakeMemory(dataLakeId ?? ''),
    queryFn: async (): Promise<LakeMemoryHealthResponse> => {
      const res = await api.get<LakeMemoryHealthResponse>(`/api/data-lakes/${dataLakeId}/lake-memory`);
      return res.data;
    },
    enabled: enabled && !!dataLakeId,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => lakeMemoryPollInterval(query.state.data),
  });
}

/** Hook: queue a full-lake (re)build of the memory profile. */
export function useBuildLakeMemory(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ ok: true; queued: true }>(`/api/data-lakes/${dataLakeId}/lake-memory`);
      return res.data;
    },
    onSuccess: () => {
      toast.success("Building this lake's memory profile...");
      if (dataLakeId) {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.lakeMemory(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
      }
    },
    onError: (error: Error) => {
      const refusal = serverRefusalMessage(error);
      if (refusal) {
        toast.error(refusal);
        return;
      }
      toast.error(error.message || 'Failed to start the lake memory build');
    },
  });
}

/**
 * Crypto-shred a lake's WHOLE memory profile, via the existing `DELETE /api/memory/lake/:id`
 * door (built for the V2 memory dashboard, not new here). Irreversible: the ledger survives but every
 * fact becomes unreadable, so the lake is treated as never-built until it is rebuilt from scratch.
 */
export function usePurgeLakeMemory(dataLakeId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.delete<{ ok: true; shredded: number }>(`/api/memory/lake/${dataLakeId}`);
      return res.data;
    },
    onSuccess: data => {
      toast.success(
        data.shredded > 0
          ? `Erased this lake's memory profile (${data.shredded} fact(s)).`
          : 'This lake had no memory profile to erase.'
      );
      if (dataLakeId) {
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.lakeMemory(dataLakeId) });
        queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
      }
    },
    onError: (error: Error) => {
      const refusal = serverRefusalMessage(error);
      toast.error(refusal || error.message || "Failed to erase this lake's memory profile");
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
      toast.error(serverRefusalMessage(error) || error.message || 'Failed to start convergence');
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
 * This hook deliberately uses the shared toggle door instead, for the batch. Both doors now apply
 * the same ownership conjunct, so their access decisions agree - but each applies it in its own
 * pre-write pass, NOT in the `addFileToLake` write they both call. `addFileToLake` cannot carry it:
 * `addFileToDataLake`'s restore path calls it deliberately WITHOUT one. So a new caller of
 * `addFileToLake` inherits no ownership check and has to grade the file's owner itself - see the
 * conjunct in `toggleTags` and `addFileToDataLake`'s own docblock. What this door does not get is
 * the restore record or the per-write audit row.
 *
 * IMPORTANT: the toggle endpoint TOGGLES the tag, so this must only ever be called with ids that
 * are NOT already members - reposting the tag for an existing member would remove it (and its
 * content-prefix tags with it, unrecoverably). The caller (Files browser) filters the selection
 * down first; `skippedCount` is purely for the success toast's wording.
 */
// Exported so a caller can gate on `useIsMutating({ mutationKey: addFilesToLakeMutationKey })`
// while this mutation is in flight, e.g. to keep a submit button disabled across an unmount.
export const addFilesToLakeMutationKey = ['addFilesToLake'] as const;

export function useAddFilesToLake() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationKey: addFilesToLakeMutationKey,
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
      const refusal = serverRefusalMessage(error);
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
      queryClient.invalidateQueries({ queryKey: fabFileKeys.all });
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
  return serverRefusalMessage(error) || 'Could not record that decision. Try again shortly.';
}

/**
 * Approve, decline, or restore (declined back to pending) one proposal. An approval admits the source
 * into the lake through the ordinary ingestion door, so it invalidates the lake's file list and health
 * alongside the queue - the file appears immediately, and its health badge stops reflecting a corpus
 * that just changed.
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
      decision: 'approve' | 'decline' | 'restore';
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
      toast.success(
        decision === 'approve'
          ? `Added "${proposal.title}" to the lake`
          : decision === 'restore'
            ? 'Proposal restored to the queue'
            : 'Proposal declined'
      );
    },
    onError: (error: unknown) => {
      toast.error(reviewProposalFailureMessage(error));
    },
  });
}

// -- Research runs (#1682) ---------------------------------------------------

/**
 * The lever set a config form submits. Every field is optional so an edit can send a patch, and
 * `recencyDays`/`model` are nullable because null is how the form CLEARS them - `undefined` means
 * "unchanged" and would leave the stored value in place.
 */
export type ResearchConfigInput = {
  name?: string;
  trigger?: ResearchRunTrigger;
  query?: string;
  model?: string | null;
  maxResults?: number;
  maxProposals?: number;
  recencyDays?: number | null;
  allowedDomains?: string[];
  blockedDomains?: string[];
  minRelevance?: number;
  costCeilingMicroUsd?: number;
  proposedTags?: string[];
};

// -- Detected corpus problems (#3039) ---------------------------------------

/**
 * How a curator narrows one lake's findings. Every field is optional and independent, and the whole
 * object is passed to the route as-is - so it doubles as the cache key, and two surfaces asking the
 * same question share one fetch.
 */
export type LakeFindingFilters = { status?: LakeFindingStatus; kind?: InconsistencyKind; limit?: number };

/**
 * One lake's detected corpus problems. Manage-gated server-side - the rows carry document EXCERPTS
 * - so a mere reader gets a 4xx, surfaced as `isForbidden` and never retried, matching
 * `useDataLakeProposals`.
 *
 * Filtering is server-side rather than a client-side pass over one fetched page: the route bounds
 * what it returns, so narrowing a page here would silently hide rows that never crossed the wire.
 *
 * No polling. Findings only change when a detection run is triggered, and a list that reshuffles
 * under a curator comparing two passages is worse than one a few minutes stale.
 */
export function useDataLakeFindings(
  dataLakeId: string | null,
  filters?: LakeFindingFilters,
  opts?: { enabled?: boolean }
) {
  const query = useInfiniteQuery({
    queryKey: dataLakeKeys.findings(dataLakeId, filters),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<{ data: IDataLakeFindingDocument[]; hasMore: boolean }>(
        `/api/data-lakes/${dataLakeId}/findings`,
        { params: { ...filters, offset: pageParam } }
      );
      return data;
    },
    // Next offset = how many rows are loaded so far; undefined once the route says there is
    // nothing left, so a queue that ends exactly on a page boundary does not draw a phantom
    // "load more".
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((n, page) => n + page.data.length, 0) : undefined,
    enabled: !!dataLakeId && (opts?.enabled ?? true),
    retry: false,
    staleTime: 1000 * 60,
    // Switching a filter re-keys the query, and without this the list blanks to a spinner on every
    // switch - the rows are a queue a curator is scanning, not a page they navigated away from.
    // Scoped to the same lake: `LakeInfoPanel` reuses this hook across lake selections, and an
    // unscoped `keepPreviousData` would carry lake A's rows over while lake B's page is loading.
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === dataLakeId ? previousData : undefined,
  });
  const findings = useMemo(() => query.data?.pages.flatMap(page => page.data), [query.data]);
  return {
    ...query,
    data: findings,
    isForbidden: isPermissionRejection(query.error),
    hasMore: query.hasNextPage,
    loadMore: query.fetchNextPage,
    isLoadingMore: query.isFetchingNextPage,
  };
}

/** The run summary POST /api/data-lakes/:id/inconsistencies answers with - the fields read here. */
type LakeScanResult = Pick<LakeInconsistencyScanSummary, 'countsByKind' | 'memberCount'>;

function describeScanResult({ countsByKind, memberCount }: LakeScanResult): string {
  // Zero members read is "nothing to scan", never "clean" - the detector draws the same line.
  if (memberCount === 0) return 'Scan complete. No document in this lake has text to compare yet.';
  const total = Object.values(countsByKind).reduce((sum, count) => sum + count, 0);
  return `Scan complete: ${total} finding(s) across ${memberCount} document(s).`;
}

/**
 * Runs detection over one lake now, rather than waiting for the nightly `lakeInconsistencySweep`.
 * The route records findings as rows and stores the run summary on the lake, so both the findings
 * queue and the health badge (which renders that summary's counts) are re-read afterwards.
 *
 * Rate-limited per caller server-side; the 429's own text ("try again in N seconds") is what the
 * error toast shows.
 */
export function useScanDataLakeFindings(dataLakeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post<LakeScanResult | null>(`/api/data-lakes/${dataLakeId}/inconsistencies`);
      return data;
    },
    onSuccess: result => {
      if (result) toast.success(describeScanResult(result));
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.findingsOf(dataLakeId) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.health(dataLakeId) });
    },
    onError: (error: Error) => {
      toast.error(serverRefusalMessage(error) || 'Could not scan this lake. Try again shortly.');
    },
  });
}

/** How often the run list re-reads while a run is queued or running. */
const RESEARCH_RUN_POLL_MS = 1000 * 5;

/**
 * One lake's saved research configurations. Manage-gated server-side, so a mere reader gets a 4xx -
 * surfaced as `isForbidden` and never retried, matching `useDataLakeSpend` and `useDataLakeProposals`.
 */
export function useDataLakeResearchConfigs(dataLakeId: string | null, opts?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: dataLakeKeys.researchConfigs(dataLakeId),
    queryFn: async () => {
      const { data } = await api.get<{ data: IDataLakeResearchConfigDocument[] }>(
        `/api/data-lakes/${dataLakeId}/research/configs`
      );
      return data.data;
    },
    enabled: !!dataLakeId && (opts?.enabled ?? true),
    retry: false,
    staleTime: 1000 * 60,
  });
  return { ...query, isForbidden: isPermissionRejection(query.error) };
}

export function useCreateDataLakeResearchConfig(dataLakeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ResearchConfigInput) => {
      const { data } = await api.post<{ data: IDataLakeResearchConfigDocument }>(
        `/api/data-lakes/${dataLakeId}/research/configs`,
        input
      );
      return data.data;
    },
    onSuccess: config => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.researchConfigs(dataLakeId) });
      toast.success(`Saved "${config.name}"`);
    },
    onError: (error: unknown) => {
      toast.error(serverRefusalMessage(error) || 'Could not save that research configuration.');
    },
  });
}

export function useUpdateDataLakeResearchConfig(dataLakeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ configId, ...input }: ResearchConfigInput & { configId: string }) => {
      const { data } = await api.put<{ data: IDataLakeResearchConfigDocument }>(
        `/api/data-lakes/${dataLakeId}/research/configs/${configId}`,
        input
      );
      return data.data;
    },
    onSuccess: config => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.researchConfigs(dataLakeId) });
      toast.success(`Updated "${config.name}"`);
    },
    onError: (error: unknown) => {
      toast.error(serverRefusalMessage(error) || 'Could not update that research configuration.');
    },
  });
}

export function useDeleteDataLakeResearchConfig(dataLakeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (configId: string) => {
      await api.delete(`/api/data-lakes/${dataLakeId}/research/configs/${configId}`);
      return configId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.researchConfigs(dataLakeId) });
      // Run history deliberately NOT invalidated: deleting a config leaves its past runs standing,
      // because a proposal's provenance points at a run.
      toast.success('Research configuration deleted');
    },
    onError: (error: unknown) => {
      toast.error(serverRefusalMessage(error) || 'Could not delete that research configuration.');
    },
  });
}

/**
 * One lake's research run history. Polls only while a run is unsettled: a run is executed by a
 * worker off a queue, so the row a user just started changes underneath them with no client event
 * to hang a refetch on. Once every run is settled the interval stops, so an idle panel is free.
 *
 * "Unsettled" is `isResearchRunInFlight`, which is age-bounded, so a run killed hard - whose row
 * keeps `running` forever because its catch never ran - stops the poll at the stale bound instead
 * of leaving the panel refetching every 5s for the life of the tab.
 */
export function useDataLakeResearchRuns(dataLakeId: string | null, opts?: { enabled?: boolean; limit?: number }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: dataLakeKeys.researchRuns(dataLakeId, opts?.limit),
    queryFn: async () => {
      const { data } = await api.get<{ data: IDataLakeResearchRunDocument[] }>(
        `/api/data-lakes/${dataLakeId}/research/runs`,
        { params: opts?.limit ? { limit: opts.limit } : undefined }
      );
      return data.data;
    },
    enabled: !!dataLakeId && (opts?.enabled ?? true),
    retry: false,
    staleTime: 1000 * 10,
    refetchInterval: query =>
      query.state.data?.some(run => isResearchRunInFlight(run)) ? RESEARCH_RUN_POLL_MS : false,
  });

  // A run settling is the moment proposals appear, and the review queue is a SEPARATE surface
  // mirroring that same fact - its tab count included. Without this the reviewer watches a run
  // report "3 proposed" and then finds Proposals still reading (0) until the window loses and
  // regains focus. Edge-triggered on the in-flight -> settled transition, so a poll that returns an
  // unchanged history does not invalidate anything.
  const anyInFlight = query.data?.some(run => isResearchRunInFlight(run)) ?? false;
  const wasInFlight = useRef(anyInFlight);
  useEffect(() => {
    const settled = wasInFlight.current && !anyInFlight;
    wasInFlight.current = anyInFlight;
    if (!settled || !dataLakeId) return;
    // Only the queue. `lastRunAt` is the config row's single run-derived field and it is stamped at
    // START, not at settle, so the invalidation the start mutation already does covers it.
    queryClient.invalidateQueries({ queryKey: dataLakeKeys.proposalsOf(dataLakeId) });
  }, [anyInFlight, dataLakeId, queryClient]);

  return { ...query, isForbidden: isPermissionRejection(query.error) };
}

/**
 * Start a run from a saved configuration. The route returns 202 with a `queued` row, so the
 * history is invalidated (the new row appears and starts the poll) along with the config list,
 * whose `lastRunAt` the start just stamped. Nothing is proposed yet - the worker does that, and a
 * reviewer still has to approve each proposal before anything enters the lake.
 */
export function useStartDataLakeResearchRun(dataLakeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (configId: string) => {
      const { data } = await api.post<{ data: IDataLakeResearchRunDocument }>(
        `/api/data-lakes/${dataLakeId}/research/runs`,
        { configId }
      );
      return data.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.researchRunsOf(dataLakeId) });
      queryClient.invalidateQueries({ queryKey: dataLakeKeys.researchConfigs(dataLakeId) });
      toast.success('Research run started. Results land in the review queue.');
    },
    onError: (error: unknown) => {
      toast.error(serverRefusalMessage(error) || 'Could not start that research run.');
    },
  });
}
