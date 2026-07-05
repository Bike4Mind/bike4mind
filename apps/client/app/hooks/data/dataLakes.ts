import type { DataLakeConfig } from '@bike4mind/common';
import type { CreateDataLakeRequestInputType, UpdateDataLakeRequestInputType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';

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

/**
 * Sets a data lake's visibility: 'private' (owner-only) or 'organization' (shared to the
 * caller's active org). Promotion sends the active account-switcher org; the server
 * authorization-validates it against the caller's memberships before scoping.
 */
export function useSetLakeVisibility() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, visibility }: { id: string; visibility: 'private' | 'organization' }) => {
      // Only a promotion needs a target org; demotion to private ignores it, so don't send it
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
      toast.success(
        visibility === 'organization' ? 'Data lake shared to your organization' : 'Data lake set to private'
      );
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to change visibility');
    },
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
