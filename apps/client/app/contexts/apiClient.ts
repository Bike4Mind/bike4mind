import axios from 'axios';
import qs from 'qs';
import { useAccessToken } from '../hooks/useAccessToken';
import { getOrCreateIdempotencyKeyWithUUID } from '@client/lib/utils/idempotency';
import { generateRequestId } from '@bike4mind/common';
import { observeDeployedRevision } from '../utils/deployRevision';
import { useClientOutdatedStore } from '../stores/useClientOutdatedStore';

/**
 * The axios instance and the request-side interceptors, split out as a LEAF module.
 *
 * Import `api` from ApiContext, not from here. This file exists only so refreshCoordinator can
 * reach the transport without importing ApiContext, which imports the coordinator back - a cycle
 * whose resolution order would decide whether the 401 interceptor is registered before the first
 * request. Splitting the transport out removes that hazard by construction rather than relying on
 * module evaluation order.
 *
 * The 401 response interceptor lives in ApiContext (it owns session teardown); anything that needs
 * refresh-and-retry must therefore go through the `api` re-exported from there. The one response
 * interceptor here only reads a header, so it has no stake in that ordering.
 */

const PUBLIC_PATHS = ['/login', '/register', '/auth/callback'];

// Exported so the cross-tab logout listener (providers.tsx) and the session-revalidation guards
// can apply the same "don't redirect away from a public/auth page" rule the interceptor uses.
export const isPublicPath = (path: string): boolean => {
  if (PUBLIC_PATHS.includes(path)) {
    return true;
  }
  // Match the /auth/*/callback pattern
  return /^\/auth\/[^/]+\/callback$/.test(path);
};

const IDEMPOTENT_METHODS = ['post', 'put', 'patch', 'delete'];

export const api = axios.create({
  paramsSerializer: params => qs.stringify(params, { arrayFormat: 'brackets' }),
  withCredentials: true,
});

// Attach a correlation ID to every request. The server echoes it back as the
// X-Request-ID response header so a failure can be traced to server logs.
api.interceptors.request.use(config => {
  config.headers = config.headers || {};

  const requestId = config.headers['X-Request-ID'] || generateRequestId();
  config.headers['X-Request-ID'] = requestId;

  // Idempotency key for mutations (server middleware currently disabled).
  if (config.method && IDEMPOTENT_METHODS.includes(config.method.toLowerCase()) && config.url) {
    config.headers['Idempotency-Key'] = getOrCreateIdempotencyKeyWithUUID(config.url, requestId);
  }
  return config;
});

// Interceptors are registered at MODULE scope (not inside ApiProvider's useEffect) so they are
// active before the first React render or data query. A useEffect runs AFTER children's
// effects/mount, so a cold-load query gated on synchronously-rehydrated state (e.g. useGetOwnSessions,
// enabled once the persisted currentUser rehydrates) could fire through `api` before the
// token-attach + 401-retry interceptors existed - sending an unauthenticated request that 401'd with
// no interceptor to refresh-and-retry it, leaving the sidebar/UI empty until a manual reload (#627).
// `api` is a singleton, so one-time registration needs no eject.

// Attach the current bearer token. Reads the store at request time so a
// post-refresh token is always used (no stale closure).
api.interceptors.request.use(config => {
  const currentToken = useAccessToken.getState().accessToken;
  if (currentToken) {
    config.headers.Authorization = `Bearer ${currentToken}`;
  }
  return config;
});

// Every baseApi response carries the revision it was served by. A revision other than the one this
// page load started on means a deploy happened under this tab; an errored response counts too,
// since a stale tab's first hint is often a 4xx/5xx it cannot explain.
// Lowercase spelling of DEPLOY_REVISION_HEADER in server/middlewares/deployRevision.ts - must stay
// in sync (apiClient.test.ts pins the pair).
const DEPLOY_REVISION_HEADER = 'x-deployed-revision';

const noteDeployedRevision = (headers: unknown): void => {
  const record = headers as Record<string, unknown> | undefined;
  // Freshness and stale-reuse windows can replay a previous deploy's revision. Such responses
  // must neither set nor be compared against the baseline. Accept quoted and zero-padded ages too.
  const cacheControl = record?.['cache-control'];
  if (
    typeof cacheControl === 'string' &&
    !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl) &&
    /(?:^|,)\s*(?:s-maxage|max-age|stale-while-revalidate|stale-if-error)\s*=\s*(?:0*[1-9]\d*|"0*[1-9]\d*")\s*(?:,|$)/i.test(
      cacheControl
    )
  )
    return;
  const revision = record?.[DEPLOY_REVISION_HEADER];
  if (typeof revision === 'string' && observeDeployedRevision(revision)) {
    useClientOutdatedStore.getState().markOutdated();
  }
};

api.interceptors.response.use(
  response => {
    noteDeployedRevision(response.headers);
    return response;
  },
  (error: unknown) => {
    noteDeployedRevision((error as { response?: { headers?: unknown } } | null)?.response?.headers);
    return Promise.reject(error);
  }
);
