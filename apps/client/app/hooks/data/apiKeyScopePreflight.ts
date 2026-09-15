import { useQuery } from '@tanstack/react-query';
import type { IApiKeyScopePreflight } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export type ScopePreflightParams = {
  endpointPrefix: string;
  scopes: string[];
  days: number;
};

/**
 * Which live API keys would start getting 403s if `scopes` were declared as
 * `requiredScopes` on the routes under `endpointPrefix`.
 *
 * Disabled until the operator supplies both inputs - this runs an unindexed scan
 * of the usage log, so it must never fire on a keystroke or an empty form.
 * `enabled` is the whole guard; there is no debounce on the input by design,
 * the operator presses Run.
 */
export const useApiKeyScopePreflight = (params: ScopePreflightParams | null) => {
  return useQuery({
    queryKey: ['admin', 'api-keys', 'scope-preflight', params],
    enabled: params !== null && params.endpointPrefix.length > 0 && params.scopes.length > 0,
    // The scan is expensive and the underlying data moves slowly (a 90-day
    // window), so do not re-run it on window focus.
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const response = await api.get<IApiKeyScopePreflight>('/api/admin/api-keys/scope-preflight', {
        params: {
          endpointPrefix: params!.endpointPrefix,
          scopes: params!.scopes.join(','),
          days: params!.days,
        },
      });
      return response.data;
    },
  });
};
