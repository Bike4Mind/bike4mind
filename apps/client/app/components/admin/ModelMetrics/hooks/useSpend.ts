import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import type { SpendData } from '../utils/spendMockData';

interface SpendFilters {
  dateFrom?: string;
  dateTo?: string;
  userFilter?: string;
  modelFilter?: string;
}

export const fetchSpend = async (filters?: SpendFilters, recache = false): Promise<SpendData> => {
  const params = new URLSearchParams();

  if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
  if (filters?.dateTo) params.append('dateTo', filters.dateTo);
  if (filters?.userFilter) params.append('userFilter', filters.userFilter);
  if (filters?.modelFilter) params.append('modelFilter', filters.modelFilter);
  // Bust the server's 12h cache entry so Refresh returns live data.
  if (recache) params.append('recache', 'true');

  const url = `/api/admin/spend${params.toString() ? `?${params.toString()}` : ''}`;
  const response = await api.get(url);
  return response.data;
};

export const useSpend = (filters?: SpendFilters) => {
  const isAdmin = useUser(s => s.isAdmin);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['admin-spend', filters],
    queryFn: () => fetchSpend(filters),
    staleTime: 1000 * 60 * 60, // 1 hour
    enabled: isAdmin,
  });

  // Force a server-side recache (bypasses the 12h response cache) and refresh the
  // query data. Mirrors useModelMetrics.recache; a plain refetch would just re-hit
  // the cached server response.
  const recache = () =>
    queryClient.fetchQuery({
      queryKey: ['admin-spend', filters],
      queryFn: () => fetchSpend(filters, true),
      staleTime: 0,
    });

  return { ...query, recache };
};
