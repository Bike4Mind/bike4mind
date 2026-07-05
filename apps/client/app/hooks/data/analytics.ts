import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { AnalyticsEventPayloads } from '@server/types/analytics';

export function useLogEvent() {
  return useMutation({
    mutationFn: async (event: Omit<AnalyticsEventPayloads, 'userId'>) => {
      try {
        return await api.post('/api/analytics/log-event', event);
      } catch (error) {
        console.warn('Analytics logging failed:', error);
        return null;
      }
    },
  });
}
