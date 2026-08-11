import { IUserDocument } from '@bike4mind/common';
import type { QueryClient } from '@tanstack/react-query';
import { api, isPublicPath } from '@client/app/contexts/ApiContext';
import { takeLegacyRefreshToken, useAccessToken } from '@client/app/hooks/useAccessToken';
import { useUser } from '@client/app/contexts/UserContext';

/**
 * Cold-load silent refresh.
 *
 * The access token is memory-only, so after any page load the app has no credential until it
 * exchanges the HttpOnly refresh cookie for a fresh one. Every protected route awaits this in
 * `beforeLoad` (see router.tsx): treating "no token yet" as "logged out" would bounce a cold
 * load through /login, whose on-mount clearClientCaches() + removeQueries() tears the session
 * down before it can be established.
 *
 * Deliberately unconditional - it does NOT check any localStorage flag first. WebKit ITP evicts
 * script-writable storage after ~7 days while leaving a server-set cookie intact, and that
 * asymmetry is the whole reason the refresh token moved into a cookie. The cost is one 401 for
 * a genuinely signed-out visitor who lands on a protected deep link.
 */

interface RefreshResponse {
  user?: IUserDocument;
  accessToken: string;
  impersonating?: boolean;
}

/** Cached for the page's lifetime: resolved OR rejected, the answer does not change until a
 *  login/logout resets it. Without caching, every route transition would re-run the exchange. */
let bootstrapPromise: Promise<void> | null = null;

/** Drop the cached result so the next protected navigation re-derives the session. Call after
 *  any client-side identity change (login, logout, impersonation swap). */
export function resetSessionBootstrap(): void {
  bootstrapPromise = null;
}

async function exchangeRefreshCookie(): Promise<void> {
  // A pre-cookie session still holds its refresh token in localStorage; send it once with
  // `cookie: true` so the server migrates it onto a cookie instead of logging the user out.
  const legacy = takeLegacyRefreshToken();

  try {
    const { data } = await api.post<RefreshResponse>(
      '/api/auth/refreshToken',
      legacy ? { token: legacy, cookie: true } : {},
      {
        // skipAuthRefresh: a 401 here means "no session", not "refresh me" - letting the
        // interceptor react would recurse and force a /login redirect on an anonymous visitor.
        skipAuthRefresh: true,
        // Same 10s bound as the interceptor's refresh: a cold Lambda must not hang the guard.
        timeout: 10000,
      }
    );

    useAccessToken.getState().setVerifiedSession(data.accessToken);
    useAccessToken.getState().setImpersonating(!!data.impersonating);
    if (data.user) {
      useUser.getState().setCurrentUser(data.user);
    }
  } catch {
    // No recoverable session. Leave the stores alone rather than marking the session expired:
    // the route guard turns a null currentUser into a /login redirect with the deep link
    // preserved, and stamping expiredReason here would show a spurious "session expired" toast
    // to someone who was simply never signed in.
  }
}

/** Idempotent; safe to await from every guard and from concurrent navigations. */
export function bootstrapSession(): Promise<void> {
  if (useAccessToken.getState().accessToken) {
    return Promise.resolve();
  }
  bootstrapPromise ??= exchangeRefreshCookie();
  return bootstrapPromise;
}

/**
 * Refocus liveness check - pure predicate, unit-testable in isolation.
 * Mirrors shouldProbeOnFailedWsConnect (WebsocketContext.tsx): decides whether a tab
 * returning to the foreground is worth pinging the server for, without doing the ping itself.
 */
export function shouldRevalidateOnFocus(params: {
  visibilityState: DocumentVisibilityState;
  accessToken: string | null;
  mfaPending: boolean;
  expired: boolean;
  pathname: string;
}): boolean {
  if (params.visibilityState !== 'visible') return false;
  if (!params.accessToken) return false;
  if (params.mfaPending) return false;
  if (params.expired) return false;
  if (isPublicPath(params.pathname)) return false;
  return true;
}

/** Single-flight guard, shared by every caller of probeIdentity below, so a refocus that
 *  coincides with a WebsocketContext close-probe fires one authed round trip, not two. */
let probeInFlight = false;

/**
 * Liveness probe shared by revalidateSessionOnFocus (below) and WebsocketContext's
 * close-probe. Refetches the `['identify']` query directly - rather than a bare
 * `api.get('/api/identify')` - so that when the 401 interceptor refreshes the token, the
 * fresh { user, accessToken } response lands back in the SAME query cache UserProvider's
 * identify effect reads. A bare fetch would leave that cache holding the pre-refresh
 * response; the effect re-runs on the accessToken change and feeds the STALE cached token
 * right back into the store, undoing the refresh (see useGetIdentify's own doc comment on
 * this exact stale-cache-feedback failure mode).
 */
export function probeIdentity(queryClient: QueryClient): Promise<void> {
  if (probeInFlight) return Promise.resolve();
  probeInFlight = true;
  return queryClient
    .refetchQueries({ queryKey: ['identify'] })
    .catch(() => {})
    .finally(() => {
      probeInFlight = false;
    });
}

/**
 * On a tab returning from idle, `bootstrapSession` only runs at page load (see router.tsx's
 * beforeLoad); nothing re-validates the session on refocus. refetchOnWindowFocus defaults to
 * false (see providers.tsx), and the handful of queries that opt in are mostly admin/settings
 * surfaces, so an idle tab's expired token could sit unrefreshed indefinitely. This fires that
 * recovery explicitly, through probeIdentity above (the SAME interceptor, no separate refresh
 * path), instead of leaving it to whichever query happens to opt in and race there first.
 */
export function revalidateSessionOnFocus(queryClient: QueryClient): void {
  const { accessToken, mfaPending, expired } = useAccessToken.getState();
  if (
    !shouldRevalidateOnFocus({
      visibilityState: document.visibilityState,
      accessToken,
      mfaPending,
      expired,
      pathname: window.location.pathname,
    })
  ) {
    return;
  }
  void probeIdentity(queryClient);
}
