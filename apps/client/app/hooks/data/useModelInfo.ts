import { useQuery } from '@tanstack/react-query';
import { getModels } from '@client/app/utils/llm';
import { useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';

export function useModelInfo() {
  // Gate on the fully-authenticated state so this doesn't fire during the login
  // mfaPending window, where /api/models would 401 (#804).
  const isFullyAuthenticated = useIsFullyAuthenticated();
  return useQuery({
    queryKey: ['llm', 'models'],
    queryFn: getModels,
    staleTime: 60 * 60 * 1000, // 1 hour
    enabled: isFullyAuthenticated,
    retry: false,
  });
}
