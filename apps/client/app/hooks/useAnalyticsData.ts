import { useQuery } from '@tanstack/react-query';
import { fetchCounterLogs } from '@client/app/utils/userAPICalls';
import { getLocalDate } from '@client/app/utils/dateUtils';
import { AnalyticsSubTab } from '../components/admin/Analytics/types';
import { useAnalyticsStore, ALL_VALUE } from '../components/admin/Analytics/store';

interface UseAnalyticsDataParams {
  startDate?: string;
  endDate?: string;
  report?: boolean;
  weeklyReport?: boolean;
}

export function useAnalyticsData(params?: UseAnalyticsDataParams) {
  const { activeSubTab, selectedOrganizations, excludedOrgs, dateFilters } = useAnalyticsStore();

  // Determine if we're in report mode from either params or activeSubTab
  const isReportMode =
    params?.report ||
    params?.weeklyReport ||
    activeSubTab === AnalyticsSubTab.DailyReport ||
    activeSubTab === AnalyticsSubTab.WeeklyReport;

  const isAllSelected = selectedOrganizations.includes(ALL_VALUE);

  const excludedOrgsList =
    !isReportMode && isAllSelected
      ? Object.entries(excludedOrgs)
          .filter(([_, isExcluded]) => isExcluded)
          .map(([key]) => {
            switch (key) {
              case 'millionOnMars':
                return 'Million on Mars';
              case 'unknown':
                return 'Unknown';
              case 'personal':
                return 'Personal';
              default:
                return key;
            }
          })
      : [];

  // Only use selectedOrganizations if not 'all' and not in report mode
  const selectedOrgs = !isReportMode && !isAllSelected ? selectedOrganizations : null;

  return useQuery({
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
    ],
    queryFn: async () => {
      // Ensure we have valid date values
      const effectiveStartDate = params?.startDate || dateFilters.startDate || getLocalDate(-7);
      const effectiveEndDate = params?.endDate || dateFilters.endDate || getLocalDate();

      const apiParams: any = {
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
        // Only add organization filters if we're not in report mode
        if (selectedOrgs) {
          apiParams.orgs = selectedOrgs;
        }
        if (excludedOrgsList.length > 0) {
          apiParams.excludeOrgs = excludedOrgsList;
        }
      }

      const { logs, reports } = await fetchCounterLogs(apiParams);

      if (isReportMode && reports) {
        return { reports, logs: [] };
      }

      return { logs: logs || [], reports: [] };
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
