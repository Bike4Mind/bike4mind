import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchCounterLogs, type AnalyticsReport, type CounterLogRow } from '@client/app/utils/userAPICalls';
import { useAnalyticsStore } from '../components/admin/Analytics/store';
import { buildUserActivityRequest } from '../components/admin/Analytics/userActivityRequest';
import type { DateRange } from '../components/admin/Analytics/dateRange';

export interface AnalyticsData {
  logs: CounterLogRow[];
  total: number;
}

interface UseAnalyticsDataOptions {
  /** Off while another sub-tab is showing, so the grid query never runs behind a report tab. */
  enabled?: boolean;
}

/**
 * The User Activity grid, driven entirely by the analytics store. The report tabs own their
 * own queries (useDailyReports, useWeeklyReports) and their own date ranges.
 */
export function useAnalyticsData({ enabled = true }: UseAnalyticsDataOptions = {}) {
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

  return useQuery<AnalyticsData>({
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

/** Daily reports for an inclusive date range; the range is owned by the Daily Report tab. */
export function useDailyReports({ startDate, endDate }: DateRange) {
  return useQuery<AnalyticsReport[]>({
    queryKey: ['analytics', 'daily-report', startDate, endDate],
    queryFn: async () => {
      const { reports } = await fetchCounterLogs({ startDate, endDate, report: true, includeInsights: true });
      return [...(reports ?? [])].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
