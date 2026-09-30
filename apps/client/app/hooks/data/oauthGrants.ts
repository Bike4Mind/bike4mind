import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface OAuthGrant {
  clientId: string;
  clientName: string;
  scopes: string[];
  approvedAt: string;
}

const QUERY_KEY = ['oauth-grants'];

export function useOAuthGrants() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await api.get<{ grants: OAuthGrant[] }>('/api/oauth/grants');
      return response.data.grants;
    },
  });
}

export function useRevokeOAuthGrant() {
  const queryClient = useQueryClient();
  return useMutation<{ revoked: boolean; clientId: string }, Error, { clientId: string }>({
    mutationFn: async ({ clientId }) => {
      const response = await api.delete(`/api/oauth/grants/${encodeURIComponent(clientId)}`);
      return response.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
