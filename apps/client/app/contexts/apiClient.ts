import axios from 'axios';
import qs from 'qs';
import { useAccessToken } from '../hooks/useAccessToken';
import { getOrCreateIdempotencyKeyWithUUID } from '@client/lib/utils/idempotency';
import { generateRequestId } from '@bike4mind/common';

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
 * refresh-and-retry must therefore go through the `api` re-exported from there.
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
