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

/** How close to its `exp` claim a token has to be before a refocus is worth a round trip.
 *  Generous enough to absorb clock skew between this tab and the server. */
const REVALIDATE_EXPIRY_BUFFER_MS = 30_000;

/** Decode the `exp` claim (seconds since epoch) from a JWT without verifying the signature
 *  (client-side only) - same pattern as UserContext's decodeTokenVersion/decodeMfaPending.
 *  Returns null when absent, malformed, or on a legacy token with no exp claim. */
function decodeTokenExpiryMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
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
  /** Injectable for tests; real callers take the default (now). */
  nowMs?: number;
}): boolean {
  if (params.visibilityState !== 'visible') return false;
  if (!params.accessToken) return false;
  if (params.mfaPending) return false;
  if (params.expired) return false;
  if (isPublicPath(params.pathname)) return false;
  const expMs = decodeTokenExpiryMs(params.accessToken);
  // No readable exp claim (malformed/legacy token) is treated as "could be stale" - probe
  // rather than silently skip, matching the fail-safe direction of every guard above.
  if (expMs !== null && expMs - (params.nowMs ?? Date.now()) > REVALIDATE_EXPIRY_BUFFER_MS) {
    return false;
  }
  return true;
}

/** Single-flight guard, shared by every caller of probeIdentity below, so a refocus that
 *  coincides with a WebsocketContext close-probe fires one authed round trip, not two. */
let probeInFlight = false;

/** Drop a stuck in-flight flag (a test left its promise unsettled). Mirrors resetRefreshPromise
 *  in ApiContext.tsx for the same guard shape. */
export function resetProbeGuardForTests(): void {
  probeInFlight = false;
}

interface IdentifyResponse {
  user: IUserDocument;
  accessToken: string;
}

/**
 * Liveness probe shared by revalidateSessionOnFocus (below) and WebsocketContext's
 * close-probe. Goes through the same `api` instance (the 401 interceptor still refreshes and
 * retries on a genuine expiry), but on SUCCESS writes the fresh response directly into the
 * `['identify']` query cache via setQueryData - the same cache UserProvider's identify effect
 * reads - so a refreshed token doesn't get fed back to stale by that effect (see
 * useGetIdentify's own doc comment on this exact stale-cache-feedback failure mode).
 *
 * Deliberately NOT queryClient.refetchQueries: that would also propagate a FAILED probe (a
 * transient network error, not a real 401) into the query's error state, and
 * resolveIdentifyEffect checks isError before isSuccess - so a laptop waking with wifi still
 * coming up would clear currentUser and bounce the user to /login. A failed probe here just
 * throws it away; the interceptor's own forceSessionExpiredRedirect (unaffected by this
 * function) is still what handles a genuinely revoked session.
 */
export function probeIdentity(queryClient: QueryClient): Promise<void> {
  if (probeInFlight) return Promise.resolve();
  probeInFlight = true;
  return (
    api
      // Bounded like the interceptor's own refresh call (ApiContext.tsx): without this, a
      // hanging server leaves probeInFlight stuck true forever, blocking every future probe
      // from both the WS close-probe and revalidateSessionOnFocus below.
      .get<IdentifyResponse>('/api/identify', { timeout: 10000 })
      .then(response => {
        queryClient.setQueryData(['identify'], response.data);
      })
      .catch(() => {})
      .finally(() => {
        probeInFlight = false;
      })
  );
}

/**
 * On a tab returning from idle, `bootstrapSession` only runs at page load (see router.tsx's
 * beforeLoad); nothing re-validates the session on refocus. refetchOnWindowFocus defaults to
 * false (see providers.tsx), and the handful of queries that opt in are mostly admin/settings
 * surfaces, so an idle tab's expired token could sit unrefreshed indefinitely. This fires that
 * recovery explicitly, through probeIdentity above (the SAME interceptor, no separate refresh
 * path), instead of leaving it to whichever query happens to opt in and race there first.
 * shouldRevalidateOnFocus's exp check means a refocus well before the token's TTL elapses
 * skips the round trip entirely, so this stays free on the common case.
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
