import axios, { isAxiosError } from 'axios';
import qs from 'qs';
import React, { PropsWithChildren, useEffect } from 'react';
import { useAccessToken } from '../hooks/useAccessToken';
import { getOrCreateIdempotencyKeyWithUUID } from '@client/lib/utils/idempotency';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import { generateRequestId } from '@bike4mind/common';

const PUBLIC_PATHS = ['/login', '/register', '/auth/callback'];

// Concurrency guard: only one token refresh at a time.
// All parallel 401s wait on the same promise instead of each spawning their own refresh.
// Exported so login flows can reset it (clears any stale pending promise from previous sessions).
export let refreshPromise: Promise<void> | null = null;
export function resetRefreshPromise() {
  refreshPromise = null;
}

// Guard so a burst of concurrent unrecoverable 401s triggers exactly one
// redirect instead of racing multiple window.location.replace calls.
// Exported so login flows can reset it, mirroring resetRefreshPromise above.
let redirecting = false;
export function resetRedirectingGuard() {
  redirecting = false;
}

/**
 * Single, idempotent teardown for a 401 that cannot be recovered by refresh
 * (already expired, no refresh token, or the refresh attempt itself failed).
 * Clears tokens, marks the session expired, wipes client caches, and redirects
 * to /login - so an unrecoverable session always ends in a clean sign-out
 * instead of silently flooding 401s with no prompt (the prior behavior for
 * the "already expired / no refresh token" branch).
 */
async function forceSessionExpiredRedirect(): Promise<void> {
  // markSessionExpired() clears the tokens AND sets expired: true in a
  // single store write, so localStorage doesn't retain stale credentials
  // and background tabs receive exactly one storage event with the final
  // expired: true payload - no transient expired: false to race against
  // the cross-tab redirect in providers.tsx. User-context localStorage
  // is cleared separately by clearClientCaches().
  useAccessToken.getState().markSessionExpired();

  // Re-check isPublicPath here: the caller's own isPublicPath check may have
  // happened before an async refresh round-trip, during which the user may
  // have navigated to /login or another public path - don't redirect there.
  if (redirecting || isPublicPath(window.location.pathname)) {
    return;
  }
  redirecting = true;

  // Await clearClientCaches before navigating: window.location.replace can unload
  // the page mid-flight and cut off its async IndexedDB/Dexie deletes, leaving the
  // previous user's cached data on disk (a concern on shared machines). The .catch
  // keeps the redirect firing even if a delete rejects; login-page mount also
  // re-clears as a backstop.
  await clearClientCaches().catch(() => {});
  window.location.replace(buildLoginRedirectUrl('session_expired', window.location));
}

// Helper function to check if a path is public.
// Exported so the cross-tab logout listener (providers.tsx) can apply the same
// "don't redirect away from a public/auth page" guard the interceptor uses.
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

export const ApiProvider: React.FC<PropsWithChildren> = ({ children }) => {
  useEffect(() => {
    // Read token directly from store on each request to avoid race conditions
    const intercepterRequest = api.interceptors.request.use(config => {
      const currentToken = useAccessToken.getState().accessToken;
      if (currentToken) {
        config.headers.Authorization = `Bearer ${currentToken}`;
      }
      return config;
    });

    return () => {
      api.interceptors.request.eject(intercepterRequest);
    };
  }, []);

  useEffect(() => {
    const interceptResponse = api.interceptors.response.use(
      response => response,
      async error => {
        const { setState, getState } = useAccessToken;

        // Ignore cancelled requests (user-initiated abort)
        if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
          return Promise.reject(error);
        }

        // TODO: have graceful toasters for customers vs developers
        // For now just a console.log
        if (isAxiosError(error)) {
          if (error.code === 'ERR_NETWORK' || error.message === 'Network Error') {
            console.error('Network Error: Backend may not be running. Check that SST is started.');
          } else {
            console.error('Axios Error:', error.response?.data || error.message);
          }
        } else {
          console.log('Axios Error', error);
        }
        /*
        toast.error(
          typeof error.response?.data?.error === 'string'
            ? error.response?.data?.error
            : error.response?.data?.message || error.message
        );
        */
        if (error.response?.status === 401 && !isPublicPath(window.location.pathname)) {
          // Skip refresh for requests that opted out (e.g., endpoints that return
          // 401 for non-auth reasons like missing API keys).
          if (error.config?.skipAuthRefresh) {
            return Promise.reject(error);
          }

          const { refreshToken, expired, mfaPending } = getState();

          // Already expired or no refresh token - don't attempt refresh.
          if (expired || !refreshToken) {
            // During mfaPending the login stage issues no refresh token by
            // design (see useAccessToken.ts), so a 401 on a non-allowlisted
            // endpoint lands here for a user who is mid-MFA-setup, not
            // actually locked out - skip the forced redirect in that case.
            if (!mfaPending) {
              await forceSessionExpiredRedirect();
            }
            return Promise.reject(error);
          }

          // Prevent secondary loops: if this request was already retried after
          // a successful refresh and still got 401, give up.
          const retryCount = error.config?._retryCount || 0;
          if (retryCount >= 1) {
            return Promise.reject(error);
          }

          // If another request is already refreshing, wait for it then retry
          if (refreshPromise) {
            try {
              await refreshPromise;
              error.config._retryCount = retryCount + 1;
              return api.request(error.config);
            } catch {
              return Promise.reject(error);
            }
          }

          // This request initiates the refresh - all other 401s will queue on this promise
          refreshPromise = (async () => {
            try {
              const response = await api.post<{ accessToken: string; refreshToken: string }>(
                '/api/auth/refreshToken',
                { token: refreshToken },
                {
                  skipAuthRefresh: true,
                  // Bound the refresh attempt so a cold Lambda or hanging server
                  // can't leave refreshPromise pending forever, which would cause
                  // every concurrent 401 (including admin-settings) to hang and
                  // keep "Checking security settings..." stuck indefinitely.
                  timeout: 10000,
                }
              );
              setState({
                accessToken: response.data.accessToken,
                refreshToken: response.data.refreshToken,
              });
            } catch (e) {
              // Only the initiator runs the teardown. Refresh failed - the session
              // can't be recovered. This mirrors the reload-recovery path
              // (RestrictedPage redirects on a missing user) and the logout
              // redirect: redirect to login instead of leaving the user stranded
              // on a page that floods 401s with no prompt. A full-page
              // window.location.replace (inside the helper) avoids a circular
              // import on the user store and unmounts the app, which also stops
              // the in-flight 401 cascade. The session_expired code surfaces a
              // toast on the login screen, and redirectTo returns the user to
              // where they were after re-login.
              await forceSessionExpiredRedirect();
              throw e;
            } finally {
              refreshPromise = null;
            }
          })();

          try {
            await refreshPromise;
            error.config._retryCount = retryCount + 1;
            return api.request(error.config);
          } catch {
            return Promise.reject(error);
          }
        }

        return Promise.reject(error);
      }
    );

    return () => {
      api.interceptors.response.eject(interceptResponse);
    };
  }, []);

  return <>{children}</>;
};
