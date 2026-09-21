import { useState } from 'react';
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

  // The recache call below is a raw request, so react-query's isFetching does not cover it.
  // Callers disable Refresh on the combined flag, which is what keeps one click to one pair of requests.
  const [isRecaching, setIsRecaching] = useState(false);

  const forceRefresh = async () => {
    setIsRecaching(true);
    try {
      // Force a server-side cache refresh
      try {
        await fetchEventMetrics(filters, true);
      } catch {
        // Swallowed here so refetch() below always runs; the query's own error state surfaces the failure.
      }
      // Then invalidate client query to get the new data
      return await query.refetch();
    } finally {
      setIsRecaching(false);
    }
  };

  return {
    ...query,
    isFetching: query.isFetching || isRecaching,
    forceRefresh,
  };
};
