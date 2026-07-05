import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IOrgSlackWorkspaceResponse } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

export const orgSlackQueryKeys = {
  all: ['org-slack'] as const,
  workspace: (orgId: string) => ['org-slack', orgId, 'workspace'] as const,
};

/**
 * Get the org's connected Slack workspace
 */
export function useGetOrgSlackWorkspace(orgId: string | null | undefined) {
  return useQuery({
    queryKey: orgSlackQueryKeys.workspace(orgId || ''),
    queryFn: async () => {
      if (!orgId) return null;
      try {
        const response = await api.get<IOrgSlackWorkspaceResponse>(`/api/organizations/${orgId}/integrations/slack`);
        return response.data;
      } catch (error) {
        // 404 means no workspace connected - return null instead of throwing
        if ((error as { response?: { status: number } })?.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },
    enabled: !!orgId,
  });
}

/**
 * Start Slack OAuth connect flow - returns the URL to redirect to
 */
export function useConnectOrgSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      const response = await api.post<{ url: string }>(`/api/organizations/${orgId}/integrations/slack/connect`);
      return response.data;
    },
    onSuccess: (_data, orgId) => {
      queryClient.invalidateQueries({ queryKey: orgSlackQueryKeys.workspace(orgId) });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

/**
 * Disconnect Slack workspace from org
 */
export function useDisconnectOrgSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (orgId: string) => {
      const response = await api.delete<{ success: boolean; message: string }>(
        `/api/organizations/${orgId}/integrations/slack`
      );
      return response.data;
    },
    onSuccess: (_data, orgId) => {
      queryClient.invalidateQueries({ queryKey: orgSlackQueryKeys.all });
      queryClient.removeQueries({ queryKey: orgSlackQueryKeys.workspace(orgId) });
      toast.success('Slack workspace disconnected');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
