import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { ModelInfo } from '@bike4mind/common';
import { getModelCatalog, type ModelCatalog } from '@client/app/utils/llm';
import { useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';

/**
 * Cache slot for /api/models. Holds the whole ModelCatalog, not a bare ModelInfo[] -
 * hooks project it with `select`, so anything reading the raw cache must go through
 * getCachedModels() rather than asserting a shape getQueryData cannot check.
 */
export const MODEL_CATALOG_QUERY_KEY = ['llm', 'models'] as const;

// Gate on the fully-authenticated state so this doesn't fire during the login
// mfaPending window, where /api/models would 401 (#804).
function catalogQuery(isFullyAuthenticated: boolean) {
  return {
    queryKey: MODEL_CATALOG_QUERY_KEY,
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

/** Model list straight from the cache, for non-React call sites. Undefined until first fetch. */
export function getCachedModels(queryClient: QueryClient): ModelInfo[] | undefined {
  return queryClient.getQueryData<ModelCatalog>(MODEL_CATALOG_QUERY_KEY)?.models;
}
