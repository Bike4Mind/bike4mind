import { useQuery } from '@tanstack/react-query';
import { fetchCounterLogs } from '@client/app/utils/userAPICalls';

interface DailyReport {
  date: string;
  report: string;
  aiInsights?: string | null;
}

interface CounterLogsResponse {
  reports?: DailyReport[];
  logs?: any[]; // for non-report responses
}

export function useDailyReports(dates: string[]) {
  return useQuery<DailyReport[]>({
    queryKey: ['daily-reports', dates],
    queryFn: async () => {
      if (dates.length === 0) return [];

      // Sort dates to get start and end
      const sortedDates = [...dates].sort();
      const startDate = sortedDates[0];
      const endDate = sortedDates[sortedDates.length - 1];

      try {
        const response = (await fetchCounterLogs({
          startDate,
          endDate,
          report: true,
          includeInsights: true,
        })) as CounterLogsResponse;

        if (response.reports) {
          // Filter to only include requested dates and sort by date (newest first)
          const dateSet = new Set(dates);
          return response.reports
            .filter(report => dateSet.has(report.date))
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        }

        return [];
      } catch (error) {
        console.error(`Failed to fetch reports:`, error);
        return [];
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
