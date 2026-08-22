import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import type { SpendData, SpendServerPayload } from '@bike4mind/common';
import { spendPeriodLabels } from '../utils/spendPeriodLabels';

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
  // The server can't format the period labels in the caller's timezone (and they're
  // kept out of its 12h cache), so add them here from the same filter dates.
  const payload = response.data as SpendServerPayload;
  return { ...payload, ...spendPeriodLabels(filters?.dateFrom, filters?.dateTo) };
};

export const useSpend = (filters?: SpendFilters, options?: { enabled?: boolean }) => {
  const isAdmin = useUser(s => s.isAdmin);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['admin-spend', filters],
    queryFn: () => fetchSpend(filters),
    staleTime: 1000 * 60 * 60, // 1 hour
    // Gate on the caller (e.g. only the active Spend tab) so the query stays lazy.
    enabled: isAdmin && (options?.enabled ?? true),
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
