import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import type { IntegrationDashboardResponse, TimeRange } from '../types';

const QUERY_KEY = 'admin-integration-health-dashboard';

export const useIntegrationHealthDashboard = (timeRange: TimeRange) => {
  const isAdmin = useUser(s => s.isAdmin);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: [QUERY_KEY, timeRange],
    queryFn: async (): Promise<IntegrationDashboardResponse> => {
      const { data } = await api.get(`/api/admin/integration-health-dashboard?timeRange=${timeRange}`);
      return data;
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 25_000,
    enabled: isAdmin,
  });

  const runProbesMutation = useMutation({
    mutationFn: async (integration?: string) => {
      const { data } = await api.post('/api/admin/integration-health-dashboard', {
        integration,
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QUERY_KEY] });
    },
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    runProbes: runProbesMutation.mutate,
    isRunningProbes: runProbesMutation.isPending,
    probeError: runProbesMutation.error,
    forceRefresh: () => query.refetch(),
  };
};
