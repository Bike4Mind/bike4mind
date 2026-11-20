import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { CustomMcpPolicy, IMcpConnectionPublic, OrgCustomMcpPolicyView } from '@bike4mind/common';
import { toast } from 'sonner';
import { getErrorMessage } from '@client/app/utils/error';

/** Org custom MCP connector policy and member connections (pages/api/organizations/[id]/custom-mcp/*). */
export const orgCustomMcpQueryKeys = {
  all: (orgId: string) => ['org-custom-mcp', orgId] as const,
  policy: (orgId: string) => ['org-custom-mcp', orgId, 'policy'] as const,
  connections: (orgId: string) => ['org-custom-mcp', orgId, 'connections'] as const,
};

const policyUrl = (orgId: string) => `/api/organizations/${orgId}/custom-mcp/policy`;

export function useOrgCustomMcpPolicy(orgId: string) {
  return useQuery({
    queryKey: orgCustomMcpQueryKeys.policy(orgId),
    queryFn: async () => (await api.get<OrgCustomMcpPolicyView>(policyUrl(orgId))).data,
    enabled: !!orgId,
  });
}

export function useOrgCustomMcpConnections(orgId: string) {
  return useQuery({
    queryKey: orgCustomMcpQueryKeys.connections(orgId),
    queryFn: async () =>
      (await api.get<IMcpConnectionPublic[]>(`/api/organizations/${orgId}/custom-mcp/connections`)).data,
    enabled: !!orgId,
  });
}

/** Both mutations answer with the new view; connection statuses depend on it, so those refetch. */
function useApplyPolicyView(orgId: string) {
  const queryClient = useQueryClient();
  return (view: OrgCustomMcpPolicyView) => {
    queryClient.setQueryData(orgCustomMcpQueryKeys.policy(orgId), view);
    queryClient.invalidateQueries({ queryKey: orgCustomMcpQueryKeys.connections(orgId) });
  };
}

export function useSaveOrgCustomMcpPolicy(orgId: string) {
  const apply = useApplyPolicyView(orgId);
  return useMutation({
    mutationFn: async (policy: CustomMcpPolicy) =>
      (await api.put<OrgCustomMcpPolicyView>(policyUrl(orgId), policy)).data,
    onSuccess: view => {
      apply(view);
      toast.success('Connector policy saved');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

export function useResetOrgCustomMcpPolicy(orgId: string) {
  const apply = useApplyPolicyView(orgId);
  return useMutation({
    mutationFn: async () => (await api.delete<OrgCustomMcpPolicyView>(policyUrl(orgId))).data,
    onSuccess: view => {
      apply(view);
      toast.success('Connector policy reset to the platform default');
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}
