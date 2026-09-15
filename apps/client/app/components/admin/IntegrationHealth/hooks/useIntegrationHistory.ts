import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import type { IntegrationHistoryResponse, IntegrationName } from '../types';

export const useIntegrationHistory = (integration: IntegrationName | null, isExpanded: boolean) => {
  const isAdmin = useUser(s => s.isAdmin);

  const query = useQuery({
    queryKey: ['admin-integration-history', integration],
    queryFn: async (): Promise<IntegrationHistoryResponse> => {
      const { data } = await api.get(
        `/api/admin/system-health/integration-health?integration=${integration}&history=true`
      );
      return data;
    },
    enabled: isAdmin && !!integration && isExpanded,
    staleTime: 60_000,
  });

  return {
    checks: query.data?.checks ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
};
