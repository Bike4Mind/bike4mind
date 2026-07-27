import type { BrowsePublicDataLakesResult, DataLakeConfig } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType, UpdateDataLakeRequestInputType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { invalidateGearsStatusWhileLocked } from '@client/app/hooks/useGearsStatus';

const DATA_LAKES_KEY = ['data-lakes'];

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

/**
 * Fetches all data lakes accessible to the current user.
 */
export function useGetDataLakes() {
  return useQuery({
    queryKey: DATA_LAKES_KEY,
    queryFn: async () => {
      const response = await api.get<{ data: DataLakeConfig[] }>('/api/data-lakes');
      return response.data.data;
    },
  });
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
      queryClient.invalidateQueries({ queryKey: DATA_LAKES_KEY });
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
      queryClient.invalidateQueries({ queryKey: DATA_LAKES_KEY });
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
      queryClient.invalidateQueries({ queryKey: DATA_LAKES_KEY });
      toast.success(VISIBILITY_TOAST[visibility]);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to change visibility');
    },
  });
}

const PUBLIC_LAKES_KEY = ['data-lakes', 'public'];

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
    queryKey: [...PUBLIC_LAKES_KEY, { search }],
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

const ARCHIVED_LAKES_KEY = ['data-lakes', 'archived'];
const DELETED_LAKES_KEY = ['data-lakes', 'deleted'];

function useLifecycleMutation(action: LifecycleAction, successMessage: string, errorMessage: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const response = await api.post(`/api/data-lakes/${id}/lifecycle`, { action });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: DATA_LAKES_KEY });
      queryClient.invalidateQueries({ queryKey: ARCHIVED_LAKES_KEY });
      queryClient.invalidateQueries({ queryKey: DELETED_LAKES_KEY });
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
    queryKey: ARCHIVED_LAKES_KEY,
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
    queryKey: DELETED_LAKES_KEY,
    enabled,
    queryFn: async () => {
      const response = await api.get<{ data: DataLakeConfig[] }>('/api/data-lakes/deleted');
      return response.data.data;
    },
  });
}
