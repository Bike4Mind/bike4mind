import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { ModelInfo } from '@bike4mind/common';
import { getModelCatalog, type ModelCatalog } from '@client/app/utils/llm';
import { useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';
import { useSelectedAccount } from '@client/app/components/Credits/selectedAccountStore';
import { orgIdOfAccount } from '@client/app/components/datalake/lakeSourceShared';

/**
 * Cache slot for /api/models. Holds the whole ModelCatalog, not a bare ModelInfo[] -
 * hooks project it with `select`, so anything reading the raw cache must go through
 * getCachedModels() rather than asserting a shape getQueryData cannot check.
 */
export const MODEL_CATALOG_QUERY_KEY = ['llm', 'models'] as const;

// One entry per active org (null = Personal): the org's model policy changes what is listed.
const catalogQueryKey = (orgId: string | null) => [...MODEL_CATALOG_QUERY_KEY, orgId] as const;

const activeOrgOf = (state: ReturnType<typeof useSelectedAccount.getState>) =>
  orgIdOfAccount(state.selectedAccount) ?? null;

/** The catalog entry for the org the account switcher has selected now. */
export const activeCatalogQueryKey = () => catalogQueryKey(activeOrgOf(useSelectedAccount.getState()));

function useActiveOrgId(): string | null {
  return useSelectedAccount(activeOrgOf);
}

const CATALOG_STALE_MS = 60 * 60 * 1000;
// Matches the server's 30s retry window for a list built without the catalog.
export const UNAVAILABLE_CATALOG_REFETCH_MS = 30_000;
const isFallback = (query: { state: { data?: ModelCatalog } }) => query.state.data?.catalogUnavailable === true;

// Gate on the fully-authenticated state so this doesn't fire during the login
// mfaPending window, where /api/models would 401 (#804).
function catalogQuery(isFullyAuthenticated: boolean, orgId: string | null) {
  return {
    queryKey: catalogQueryKey(orgId),
    queryFn: () => getModelCatalog(orgId),
    staleTime: (query: { state: { data?: ModelCatalog } }) =>
      isFallback(query) ? UNAVAILABLE_CATALOG_REFETCH_MS : CATALOG_STALE_MS,
    refetchInterval: (query: { state: { data?: ModelCatalog } }) =>
      isFallback(query) ? UNAVAILABLE_CATALOG_REFETCH_MS : false,
    enabled: isFullyAuthenticated,
    // One blip would otherwise leave the composer on "no models" for the whole session.
    retry: 2,
  } as const;
}

export function useModelInfo() {
  const isFullyAuthenticated = useIsFullyAuthenticated();
  // Same query key as useSupersededModels, so both read one fetch of /api/models.
  const orgId = useActiveOrgId();
  return useQuery({ ...catalogQuery(isFullyAuthenticated, orgId), select: catalog => catalog.models });
}

/** Retired/superseded model ids paired with their replacements (see SupersededModelInfo). */
export function useSupersededModels() {
  const isFullyAuthenticated = useIsFullyAuthenticated();
  const orgId = useActiveOrgId();
  return useQuery({ ...catalogQuery(isFullyAuthenticated, orgId), select: catalog => catalog.supersededModels });
}

/** Models the picker shows as locked (paid-only, or not allowed by the org); display only (see ModelInfo.access). */
export function useLockedModels() {
  const isFullyAuthenticated = useIsFullyAuthenticated();
  const orgId = useActiveOrgId();
  return useQuery({ ...catalogQuery(isFullyAuthenticated, orgId), select: catalog => catalog.lockedModels });
}

/** Model list straight from the cache, for non-React call sites. Undefined until first fetch. */
export function getCachedModels(queryClient: QueryClient): ModelInfo[] | undefined {
  return queryClient.getQueryData<ModelCatalog>(activeCatalogQueryKey())?.models;
}
