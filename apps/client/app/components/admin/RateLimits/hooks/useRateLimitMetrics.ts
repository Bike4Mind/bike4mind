import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import type { RateLimitFilters, RateLimitSnapshot } from '../types';

const fetchRateLimitSnapshots = async (filters?: RateLimitFilters): Promise<RateLimitSnapshot[]> => {
  const params = new URLSearchParams();
  if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
  if (filters?.dateTo) params.append('dateTo', filters.dateTo);
  if (filters?.integration) params.append('integration', filters.integration);
  if (filters?.throttledOnly) params.append('throttledOnly', 'true');

  const url = `/api/admin/rate-limits${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await api.get(url);
  return response.data;
};

export const useRateLimitMetrics = (filters?: RateLimitFilters) => {
  const isAdmin = useUser(s => s.isAdmin);

  const query = useQuery({
    queryKey: ['admin-rate-limits', filters],
    queryFn: () => fetchRateLimitSnapshots(filters),
    staleTime: 1000 * 60 * 5, // 5 minutes
    enabled: isAdmin,
  });

  return {
    data: query.data ?? [],
    isLoading: query.isLoading,
    forceRefresh: () => query.refetch(),
  };
};
