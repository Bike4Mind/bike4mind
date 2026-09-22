import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  const queryClient = useQueryClient();
  const queryKey = ['event-metrics', filters];

  const query = useQuery({
    queryKey,
    queryFn: () => fetchEventMetrics(filters),
    staleTime: 1000 * 60 * 1, // 1 minute for filtered data
  });

  // The recache response carries the rebuilt metrics, so it seeds the query cache instead of
  // issuing a second read. A second read would succeed off the untouched 12h server cache and
  // hide a failed recache behind stale numbers.
  const recacheMutation = useMutation({
    mutationFn: (recacheFilters?: MetricsFilters) => fetchEventMetrics(recacheFilters, true),
    onSuccess: metrics => queryClient.setQueryData(queryKey, metrics),
  });

  // A failed recache stays visible until the next attempt, but it belongs to the filter set it was
  // issued for - a later filter change must not keep showing it above freshly loaded data.
  const recacheFailed =
    recacheMutation.isError && JSON.stringify(recacheMutation.variables ?? {}) === JSON.stringify(filters ?? {});

  const forceRefresh = () => recacheMutation.mutate(filters);

  return {
    ...query,
    isFetching: query.isFetching || recacheMutation.isPending,
    isError: query.isError || recacheFailed,
    error: query.error ?? (recacheFailed ? recacheMutation.error : null),
    forceRefresh,
  };
};
