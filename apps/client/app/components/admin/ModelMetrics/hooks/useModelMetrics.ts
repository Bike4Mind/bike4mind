import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { ModelMetric } from '../types';

interface MetricsFilters {
  dateFrom?: string;
  dateTo?: string;
  userFilter?: string;
  modelFilter?: string;
  statusFilter?: string;
}

export const fetchModelMetrics = async (filters?: MetricsFilters, recache = false): Promise<ModelMetric[]> => {
  const params = new URLSearchParams();

  if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
  if (filters?.dateTo) params.append('dateTo', filters.dateTo);
  if (filters?.userFilter) params.append('userFilter', filters.userFilter);
  if (filters?.modelFilter) params.append('modelFilter', filters.modelFilter);
  if (filters?.statusFilter) params.append('statusFilter', filters.statusFilter);
  // Bust the server's 12h `getCachedData` entry so Refresh returns live data.
  if (recache) params.append('recache', 'true');

  const url = `/api/admin/model-metrics${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await api.get(url);
  return response.data;
};

export const useModelMetrics = (filters?: MetricsFilters) => {
  const isAdmin = useUser(s => s.isAdmin);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['model-metrics', filters],
    queryFn: () => fetchModelMetrics(filters),
    staleTime: 1000 * 60 * 60, // 1 hour
    enabled: isAdmin,
  });

  // Force a server-side recache (bypasses the 12h response cache) and refresh the
  // query data. Used by the Refresh button; a plain refetch would just re-hit the
  // cached server response.
  const recache = () =>
    queryClient.fetchQuery({
      queryKey: ['model-metrics', filters],
      queryFn: () => fetchModelMetrics(filters, true),
      staleTime: 0,
    });

  return { ...query, recache };
};
