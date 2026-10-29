import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { adminUsersQueryKey } from './useAdminUsersList';
import type {
  AdminUsersBulkExecuteRequest,
  AdminUsersBulkPreview,
  AdminUsersBulkPreviewRequest,
  AdminUsersBulkResult,
  AdminUsersBulkUndoResult,
} from '@client/app/utils/adminUsersBulk';

/** Dry run: writes nothing. `null` keeps it idle while the dialog's inputs are incomplete. */
export function useAdminUsersBulkPreview(request: AdminUsersBulkPreviewRequest | null) {
  return useQuery({
    queryKey: ['admin-users-bulk-preview', request],
    queryFn: async () => {
      const { data } = await api.post<AdminUsersBulkPreview>('/api/admin/users/bulk/preview', request);
      return data;
    },
    enabled: request !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useAdminUsersBulkExecute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: AdminUsersBulkExecuteRequest) => {
      const { data } = await api.post<AdminUsersBulkResult>('/api/admin/users/bulk/execute', request);
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminUsersQueryKey }),
  });
}

export function useAdminUsersBulkUndo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (batchId: string) => {
      const { data } = await api.post<AdminUsersBulkUndoResult>('/api/admin/users/bulk/undo', { batchId });
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminUsersQueryKey }),
  });
}
