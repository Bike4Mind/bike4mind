import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  fetchCounterLogs,
  type AnalyticsReport,
  type CounterLogRow,
  type FetchCounterLogsParams,
} from '@client/app/utils/userAPICalls';
import { getLocalDate } from '@client/app/utils/dateUtils';
import { AnalyticsSubTab } from '../components/admin/Analytics/types';
import { useAnalyticsStore } from '../components/admin/Analytics/store';
import { buildUserActivityRequest } from '../components/admin/Analytics/userActivityRequest';

interface UseAnalyticsDataParams {
  startDate?: string;
  endDate?: string;
  report?: boolean;
  weeklyReport?: boolean;
}

export interface AnalyticsData {
  logs: CounterLogRow[];
  reports: AnalyticsReport[];
  total: number;
}

export function useAnalyticsData(params?: UseAnalyticsDataParams) {
  const {
    activeSubTab,
    selectedOrganizations,
    excludedOrgs,
    dateFilters,
    userActivityFilters,
    metadataFilters,
    page,
    limit,
  } = useAnalyticsStore();

  // Determine if we're in report mode from either params or activeSubTab
  const isReportMode =
    params?.report ||
    params?.weeklyReport ||
    activeSubTab === AnalyticsSubTab.DailyReport ||
    activeSubTab === AnalyticsSubTab.WeeklyReport;

  // Shared with the CSV export so the exported rows always match the grid.
  const userActivityRequest = buildUserActivityRequest({
    dateFilters,
    selectedOrganizations,
    excludedOrgs,
    userActivityFilters,
    metadataFilters,
  });

  return useQuery<AnalyticsData>({
    queryKey: [
      'analytics',
      activeSubTab,
      selectedOrganizations,
      // Include each excluded org separately in the query key to ensure
      // the query is refetched when any of them change
      excludedOrgs.millionOnMars,
      excludedOrgs.unknown,
      excludedOrgs.personal,
      // Use params dates if provided, otherwise use dateFilters
      params?.startDate || dateFilters.startDate,
      params?.endDate || dateFilters.endDate,
      // Include report flags in the query key
      params?.report,
      params?.weeklyReport,
      // Server-side paging/filtering: every one of these changes the response, so each has
      // to be in the key or react-query serves the previous page's rows.
      page,
      limit,
      userActivityFilters.counterNameSearch,
      userActivityFilters.userEmailSearch,
      metadataFilters,
    ],
    queryFn: async () => {
      // Ensure we have valid date values
      const effectiveStartDate = params?.startDate || dateFilters.startDate || getLocalDate(-7);
      const effectiveEndDate = params?.endDate || dateFilters.endDate || getLocalDate();

      const apiParams: Partial<FetchCounterLogsParams> = {
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
      };

      // Only add report-related parameters if we're in report mode
      if (isReportMode) {
        // Use params report flags if provided, otherwise determine from activeSubTab
        apiParams.report = params?.report !== undefined ? params.report : activeSubTab === AnalyticsSubTab.DailyReport;
        apiParams.weeklyReport =
          params?.weeklyReport !== undefined ? params.weeklyReport : activeSubTab === AnalyticsSubTab.WeeklyReport;
        apiParams.includeInsights = true;
      } else {
        // Effective dates last: an explicit params override must win over the store's range.
        Object.assign(apiParams, userActivityRequest, {
          startDate: effectiveStartDate,
          endDate: effectiveEndDate,
          page,
          limit,
        });
      }

      const { logs, reports, total } = await fetchCounterLogs(apiParams);

      if (isReportMode && reports) {
        return { reports, logs: [], total: 0 };
      }

      return { logs: logs || [], reports: [], total: total ?? 0 };
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    // A page turn or refresh re-runs an 8-9s aggregation; the previous page is still the right
    // thing to show while it does, rather than blanking the whole tab. Scoped to the paged grid:
    // the report tabs have no "stale but visible" affordance wired up, so keeping their previous
    // range on screen with no progress indicator would read as a stuck request.
    placeholderData: isReportMode ? undefined : keepPreviousData,
  });
}
