import type {
  BulkAbuseExecuteRequest,
  BulkAbuseExecuteResult,
  BulkAbusePreview,
  BulkAbusePreviewRequest,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';

/** Dry run: writes nothing, returns the counts and the previewToken that execute must send back. */
export function useBulkAbusePreview() {
  return useMutation({
    mutationFn: async (request: BulkAbusePreviewRequest) => {
      const { data } = await api.post<BulkAbusePreview>('/api/admin/abuse/bulk-preview', request);
      return data;
    },
  });
}

export function useBulkAbuseExecute() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: BulkAbuseExecuteRequest) => {
      const { data } = await api.post<BulkAbuseExecuteResult>('/api/admin/abuse/bulk-execute', request);
      return data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  });
}
