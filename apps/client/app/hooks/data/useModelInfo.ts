import { useQuery } from '@tanstack/react-query';
import { getModelCatalog } from '@client/app/utils/llm';
import { useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';

// Gate on the fully-authenticated state so this doesn't fire during the login
// mfaPending window, where /api/models would 401 (#804).
function catalogQuery(isFullyAuthenticated: boolean) {
  return {
    queryKey: ['llm', 'models'],
    queryFn: getModelCatalog,
    staleTime: 60 * 60 * 1000, // 1 hour
    enabled: isFullyAuthenticated,
    retry: false,
  } as const;
}

export function useModelInfo() {
  const isFullyAuthenticated = useIsFullyAuthenticated();
  // Same query key as useSupersededModels, so both read one fetch of /api/models.
  return useQuery({ ...catalogQuery(isFullyAuthenticated), select: catalog => catalog.models });
}

/** Retired/superseded model ids paired with their replacements (see SupersededModelInfo). */
export function useSupersededModels() {
  const isFullyAuthenticated = useIsFullyAuthenticated();
  return useQuery({ ...catalogQuery(isFullyAuthenticated), select: catalog => catalog.supersededModels });
}
