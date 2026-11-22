import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';
import type { CallableFunctionsStatus } from '@pages/api/callable-functions/status';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { CALLABLE_FUNCTIONS_STATUS_QUERY_KEY } from './queryKeys';

/** Whether this user may call Python artifact functions. False while loading and on any error. */
export function useCallableFunctionsEnabled(): boolean {
  const hasAccessToken = useAccessToken(s => !!s.accessToken);
  const { data } = useQuery({
    queryKey: CALLABLE_FUNCTIONS_STATUS_QUERY_KEY,
    queryFn: async () => (await api.get<CallableFunctionsStatus>('/api/callable-functions/status')).data,
    enabled: hasAccessToken,
    staleTime: 5 * 60 * 1000,
  });
  return data?.enabled === true;
}
