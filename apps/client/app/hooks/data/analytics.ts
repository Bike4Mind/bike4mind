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

/** The policy interstitial is reachable before the generic analytics route is permitted. */
export function useLogPoliciesShown() {
  return useMutation({
    mutationFn: async () => api.post('/api/user/accept-policies/shown', {}),
    onError: error => console.warn('Policy interstitial analytics logging failed:', error),
  });
}
