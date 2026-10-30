import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { AnalyticsEventPayloads } from '@bike4mind/server-utils/types/analytics/index';

export function useLogEvent() {
  return useMutation({
    mutationFn: async (event: Omit<AnalyticsEventPayloads, 'userId'>) => {
      if (useAccessToken.getState().impersonating) return null;
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
