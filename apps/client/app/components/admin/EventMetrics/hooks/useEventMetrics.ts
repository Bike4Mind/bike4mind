import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { EventMetric } from '../types';

interface MetricsFilters {
  dateFrom?: string;
  dateTo?: string;
  userFilter?: string;
  eventFilter?: string;
  eventCategoryFilter?: string;
}

export const fetchEventMetrics = async (filters?: MetricsFilters, recache: boolean = false): Promise<EventMetric[]> => {
  const params = new URLSearchParams();
  if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
  if (filters?.dateTo) params.append('dateTo', filters.dateTo);
  if (filters?.userFilter) params.append('userFilter', filters.userFilter);
  if (filters?.eventFilter) params.append('eventFilter', filters.eventFilter);
  if (filters?.eventCategoryFilter) params.append('eventCategoryFilter', filters.eventCategoryFilter);
  if (recache) params.append('recache', 'true');

  const url = `/api/admin/event-metrics${params.toString() ? `?${params.toString()}` : ''}`;

  const response = await api.get(url);
  if (Array.isArray(response.data)) {
    return response.data;
  }
  console.error('Event metrics API returned non-array data:', response.data);
  return [];
};

export const useEventMetrics = (filters?: MetricsFilters) => {
  const query = useQuery({
    queryKey: ['event-metrics', filters],
    queryFn: () => fetchEventMetrics(filters),
    staleTime: 1000 * 60 * 1, // 1 minute for filtered data
  });

  const forceRefresh = async () => {
    // Force a server-side cache refresh
    await fetchEventMetrics(filters, true);
    // Then invalidate client query to get the new data
    return query.refetch();
  };

  return {
    ...query,
    forceRefresh,
  };
};
