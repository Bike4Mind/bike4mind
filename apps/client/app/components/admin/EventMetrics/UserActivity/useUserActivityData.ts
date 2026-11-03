import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchCounterLogs, type CounterLogRow } from '@client/app/utils/userAPICalls';
import { useAnalyticsStore } from './store';
import { buildUserActivityRequest } from './userActivityRequest';

export interface UserActivityData {
  logs: CounterLogRow[];
  total: number;
}

interface UseUserActivityDataOptions {
  enabled?: boolean;
}

/** The User Activity grid, driven entirely by the user activity store. */
export function useUserActivityData({ enabled = true }: UseUserActivityDataOptions = {}) {
  const { selectedOrganizations, exclusions, dateFilters, userActivityFilters, metadataFilters, page, limit } =
    useAnalyticsStore();

  // Shared with the CSV export so the exported rows always match the grid.
  const userActivityRequest = buildUserActivityRequest({
    dateFilters,
    selectedOrganizations,
    exclusions,
    userActivityFilters,
    metadataFilters,
  });

  return useQuery<UserActivityData>({
    // Every field of the request changes the response, so the whole request is the key.
    queryKey: ['analytics', 'user-activity', userActivityRequest, page, limit],
    queryFn: async () => {
      const { logs, total } = await fetchCounterLogs({ ...userActivityRequest, page, limit });
      return { logs: logs ?? [], total: total ?? 0 };
    },
    enabled,
    staleTime: 1000 * 60 * 5, // 5 minutes
    // A page turn or refresh re-runs an 8-9s aggregation; the previous page is still the right
    // thing to show while it does, rather than blanking the whole tab.
    placeholderData: keepPreviousData,
  });
}
