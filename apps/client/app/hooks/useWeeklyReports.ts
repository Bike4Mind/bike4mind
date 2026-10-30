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

type WeekResult = { report: WeeklyReport; failure?: { error: unknown } };

const fetchWeeklyReport = async (week: WeekRange): Promise<WeekResult> => {
  try {
    const response = await fetchCounterLogs({
      startDate: week.start,
      endDate: week.end,
      weeklyReport: true,
      includeInsights: true,
    });
    const report = response.reports?.[0];
    if (!report) return { report: { startDate: week.start, endDate: week.end, error: 'No report data available' } };
    return {
      report: { startDate: week.start, endDate: week.end, report: report.report, aiInsights: report.aiInsights },
    };
  } catch (error) {
    console.error('Failed to fetch report for week %s to %s:', week.start, week.end, error);
    return {
      report: {
        startDate: week.start,
        endDate: week.end,
        error: error instanceof Error ? error.message : 'Failed to fetch report',
      },
      failure: { error },
    };
  }
};

/**
 * One failed week is shown on that week's card, so the others stay readable. When every week
 * failed there is nothing to show, so the query rejects and the tab renders its error card.
 */
export function useWeeklyReports(selectedWeeks: WeekRange[]) {
  return useQuery<WeeklyReport[]>({
    queryKey: ['weekly-reports', selectedWeeks],
    queryFn: async () => {
      // A manual refetch() ignores `enabled`, so zero weeks still reaches here.
      if (selectedWeeks.length === 0) return [];
      const results: WeekResult[] = [];
      // Sequential on purpose: each week runs an LLM insights pass on the server.
      for (const week of selectedWeeks) {
        results.push(await fetchWeeklyReport(week));
      }

      const failures = results.flatMap(result => (result.failure ? [result.failure.error] : []));
      if (failures.length === results.length) {
        throw failures[0];
      }

      return results
        .map(result => result.report)
        .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    },
    enabled: selectedWeeks.length > 0,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
