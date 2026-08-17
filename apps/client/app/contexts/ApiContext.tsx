import axios, { isAxiosError } from 'axios';
import React, { PropsWithChildren } from 'react';
import { useAccessToken } from '../hooks/useAccessToken';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import { api, isPublicPath } from './apiClient';
import { refreshSession } from '@client/app/utils/refreshCoordinator';

// The axios instance and its request-side interceptors live in ./apiClient (a leaf module, so the
// refresh coordinator can reach the transport without importing this file back). Re-exported here
// because THIS is the module that registers the 401 refresh-and-retry interceptor: importing `api`
// from anywhere else would silently opt out of it.
export { api, isPublicPath };

// Guard so a burst of concurrent unrecoverable 401s triggers exactly one
// redirect instead of racing multiple window.location.replace calls.
// Exported so login flows can reset it (as they reset the refresh coordinator).
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
 *
 * Exported so callers with their own unrecoverable-auth-failure signal (e.g.
 * accept-policies.tsx, whose consent gate has no server session to fall back
 * on) can reuse this teardown instead of duplicating it.
 */
export async function forceSessionExpiredRedirect(): Promise<void> {
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

// Exported so callers outside the interceptor (e.g. accept-policies.tsx) can apply the
// same "is this actually an unrecoverable auth rejection, or just a transient failure"
// distinction the refresh-retry catch below makes, instead of re-deriving it per caller.
export const getAxiosErrorStatus = (error: unknown): number | undefined =>
  isAxiosError(error) ? error.response?.status : undefined;

// Exported so callers can tell whether the interceptor already completed a full
// refresh-succeeded-then-retried cycle for this error (stamped below as `_retryCount`) -
// a stronger "already tried, still failed" signal than a bare 401 status, which a caller
// can hit on its very first attempt whenever the refresh itself (not the retry) failed.
export const getAxiosRetryCount = (error: unknown): number =>
  (isAxiosError(error) ? (error.config as { _retryCount?: number } | undefined)?._retryCount : undefined) ?? 0;

// On 401: refresh the token once and retry; tear down cleanly if unrecoverable.
// Registered at MODULE scope (not inside ApiProvider's useEffect) for the same reason as the
// request interceptors in ./apiClient - see the note there.
api.interceptors.response.use(
  response => response,
  async error => {
    const { getState } = useAccessToken;

    // Ignore cancelled requests (user-initiated abort)
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      return Promise.reject(error);
    }

    // A 401 during the login mfaPending window is expected, not an error: the
    // server rejects every non-allowlisted request while mid-MFA with
    // { mfaPending: true } (see server/auth/auth.ts). The app shell fires its
    // data queries before MFA completes, so logging these would spam ~40 lines
    // per login and bury real errors (#804). Skip logging them; still let the
    // 401 handling below run (it already no-ops the redirect for mfaPending).
    const isMfaPending401 =
      isAxiosError(error) && error.response?.status === 401 && error.response?.data?.mfaPending === true;

    // Suppress logging for the expected mid-MFA rejection; log everything else.
    // TODO: have graceful toasters for customers vs developers
    // For now just a console.log
    if (!isMfaPending401) {
      if (isAxiosError(error)) {
        if (error.code === 'ERR_NETWORK' || error.message === 'Network Error') {
          console.error('Network Error: Backend may not be running. Check that SST is started.');
        } else {
          console.error('Axios Error:', error.response?.data || error.message);
        }
      } else {
        console.log('Axios Error', error);
      }
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

      const { expired, mfaPending } = getState();

      // During mfaPending the login stage issues no refresh token or cookie by design (see
      // useAccessToken.ts), so a 401 on a non-allowlisted endpoint is the expected mid-MFA
      // rejection, not a lockout: there is nothing to refresh and nowhere to redirect.
      if (mfaPending) {
        return Promise.reject(error);
      }

      // Already torn down by a previous unrecoverable 401 - don't attempt refresh again.
      if (expired) {
        await forceSessionExpiredRedirect();
        return Promise.reject(error);
      }

      const retryCount = error.config?._retryCount || 0;

      // A 401 about a token we have ALREADY replaced is stale news, not a reason to refresh again -
      // and not evidence that the session is dead. A request that was in flight when someone else's
      // refresh landed (or when a sibling tab broadcast its token) comes back rejecting the
      // credential it was SENT with, which is no longer the credential we hold. Exchanging the
      // cookie again would spend a rotation the first one already consumed, and its 400 would read
      // as a revocation and log the user out of a perfectly healthy session.
      //
      // This is checked BEFORE the teardown below, deliberately. The teardown's premise is "we
      // refreshed and the token we minted was still rejected" - but if the store has moved on since
      // this request was sent, that premise is false: there is a newer token nobody has tried yet.
      // Tearing down there would sign out a tab holding a working credential, which is the exact
      // failure class this change exists to remove. Ordering it first cannot weaken the teardown,
      // which is independently bounded by its own flag.
      //
      // Bounded by its OWN flag, not _retryCount: the token we swap in may itself be expired
      // (sibling tabs' tokens expire together), and a 401 on it must still be allowed to drive a
      // real refresh below. Charging it to _retryCount would instead trip the teardown on the next
      // pass, logging the user out without ever having refreshed.
      const presentedToken = String(error.config?.headers?.Authorization ?? '').replace(/^Bearer /, '');
      const heldToken = getState().accessToken;
      if (!error.config?._staleTokenRetried && heldToken && presentedToken && heldToken !== presentedToken) {
        error.config._staleTokenRetried = true;
        return api.request(error.config);
      }

      // A refresh already succeeded (_retryCount is only bumped after the refresh RESOLVES) and we
      // retried once, yet this request STILL 401s with the token we currently hold. When it is a
      // bare auth-layer rejection, the freshly minted token is being rejected, so the session is
      // unrecoverable - e.g. a server-side token/session mismatch where /api/auth/refreshToken
      // keeps returning 200 but the access verifier keeps rejecting the token it mints. Left
      // un-torn-down, the session stays alive (expired: false) and every repeating trigger -
      // WS reconnect probes, tab-focus probes, polling queries - re-drives another
      // refresh+retry cycle forever (the "401 storm a reload can't fix, only re-login").
      //
      // BUT a 401 that carries an application-level error `code` PASSED auth (a fresh token
      // would too) and failed for a DOMAIN reason - e.g. /api/mcp-servers/notion/pages returns
      // 401 + code NOTION_RECONNECT_REQUIRED when a user's Notion OAuth is revoked, a routine
      // event unrelated to the JWT session. Tearing the whole session down there would log the
      // user out of the app on a scoped, expected error. So only tear down on a code-less
      // rejection; a coded 401 falls through to the plain reject (the pre-PR behavior, letting
      // the caller surface its own error).
      if (retryCount >= 1) {
        if (!error.response?.data?.code) {
          await forceSessionExpiredRedirect();
        }
        return Promise.reject(error);
      }

      // The refresh cookie rides along on `withCredentials`; the rotated one comes back the same
      // way and is never visible to this code. refreshSession deduplicates across every concurrent
      // 401 in every tab, so a burst here costs one exchange, not one per request.
      try {
        await refreshSession();
      } catch (e) {
        // Distinguish a genuine revocation from a transient outage by the refresh endpoint's
        // status: a 400 (invalid_grant) / 401 means the refresh token was rejected - the session
        // can't be recovered, so tear down. A 5xx / network error / the 10s timeout is a transient
        // outage (a cold or hanging refresh Lambda) - reject and let the caller retry rather than
        // logging the user out on a blip. This matters most during a deploy, when WS connections
        // drop (triggering the WebsocketContext probe through this same interceptor) at the exact
        // moment the refresh Lambda is coldest - without this gate that correlation causes
        // spurious logout storms. Mirrors the CLI ApiClient's SessionRevokedError distinction.
        //
        // The teardown: forceSessionExpiredRedirect mirrors the reload-recovery path (RestrictedPage
        // redirects on a missing user) and the logout redirect - a full-page window.location.replace
        // (inside the helper) avoids a circular import on the user store, unmounts the app, and
        // stops the in-flight 401 cascade. The session_expired code surfaces a toast on the login
        // screen, and redirectTo returns the user to where they were after re-login.
        //
        // Every queued caller runs this, but forceSessionExpiredRedirect is idempotent, so the
        // burst still produces exactly one teardown and one redirect.
        const refreshStatus = getAxiosErrorStatus(e);
        if (refreshStatus === 400 || refreshStatus === 401) {
          await forceSessionExpiredRedirect();
        }
        return Promise.reject(error);
      }

      error.config._retryCount = retryCount + 1;
      return api.request(error.config);
    }

    return Promise.reject(error);
  }
);

// ApiProvider no longer registers interceptors (they live at module scope above,
// so they're active before any render). Kept as a pass-through to preserve the
// provider tree / mount point in providers.tsx.
export const ApiProvider: React.FC<PropsWithChildren> = ({ children }) => <>{children}</>;
