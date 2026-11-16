import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ClientConfigResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';
import { isMfaEnrollmentRequired } from '@client/app/utils/mfaEnrollmentInterceptor';

export const clientConfigQuery = queryOptions({
  queryKey: ['client-config'] as const,
  queryFn: async () => (await api.get<ClientConfigResponse>('/api/v1/client-config')).data,
  staleTime: 5 * 60 * 1000,
  refetchOnWindowFocus: false,
  retry: (failureCount, error) => {
    const status = (error as { response?: { status?: number } }).response?.status;
    return status !== 401 && !isMfaEnrollmentRequired(error) && failureCount < 3;
  },
});

export function useClientConfig() {
  const enabled = useIsFullyAuthenticated();
  return useQuery({ ...clientConfigQuery, enabled });
}
