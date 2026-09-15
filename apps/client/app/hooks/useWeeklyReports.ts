import { useQuery } from '@tanstack/react-query';
import { fetchCounterLogs } from '@client/app/utils/userAPICalls';
import { WeekRange } from '../components/admin/Analytics/filters/WeekPicker';

export interface WeeklyReport {
  startDate: string;
  endDate: string;
  report?: string;
  aiInsights?: string | null;
  error?: string;
}

export function useWeeklyReports(selectedWeeks: WeekRange[]) {
  return useQuery<WeeklyReport[]>({
    queryKey: ['weekly-reports', selectedWeeks],
    queryFn: async () => {
      if (selectedWeeks.length === 0) return [];

      const reports: WeeklyReport[] = [];

      for (const week of selectedWeeks) {
        try {
          const response = await fetchCounterLogs({
            startDate: week.start,
            endDate: week.end,
            weeklyReport: true,
            includeInsights: true,
          });

          if (response.reports?.[0]) {
            reports.push({
              startDate: week.start,
              endDate: week.end,
              report: response.reports[0].report,
              aiInsights: response.reports[0].aiInsights,
            });
          } else {
            reports.push({
              startDate: week.start,
              endDate: week.end,
              error: 'No report data available',
            });
          }
        } catch (error) {
          console.error('Failed to fetch report for week %s to %s:', week.start, week.end, error);
          reports.push({
            startDate: week.start,
            endDate: week.end,
            error: error instanceof Error ? error.message : 'Failed to fetch report',
          });
        }
      }

      // Sort by date (newest first)
      return reports.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
