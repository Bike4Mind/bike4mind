import { IUserDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/apiClient';
import { takeLegacyRefreshToken, useAccessToken } from '@client/app/hooks/useAccessToken';

/**
 * The single place the app exchanges the HttpOnly refresh cookie.
 *
 * The problem this solves: the refresh cookie is ONE value shared by every tab, but the access
 * token is per-tab memory. Left uncoordinated, N tabs (whose tokens expire within seconds of each
 * other, since they came from the same login) each refresh independently. The server now tolerates
 * that - see rotateSession's compare-and-swap - but tolerating it is not the same as wanting it:
 * every extra exchange is a wasted round trip and a needless narrowing of the replay window.
 *
 * Three layers, outermost first:
 *  1. Cross-tab exclusion (Web Locks). Only one tab in the whole origin exchanges at a time.
 *  2. Adopt-instead-of-exchange. On acquiring the lock, a waiter that finds the token already
 *     replaced (by this tab or a sibling) returns it rather than making a second round trip.
 *  3. In-tab single flight, so a burst of concurrent 401s inside one tab collapses to one call.
 *
 * Layer 2 also closes a gap layer 3 alone cannot: the in-flight promise clears as soon as the
 * first refresh settles, so a request whose 401 lands just after that would otherwise start a
 * second exchange against a cookie the first one already rotated.
 */

export interface RefreshedSession {
  accessToken: string;
  /**
   * Present only when this call actually exchanged the cookie. A caller that was served an
   * already-current token (the adopt path below) gets a token but NO identity - nobody in this tab
   * ever saw the refresh response that carried it. Callers that need the user must resolve it
   * themselves; see sessionBootstrap.
   */
  user?: IUserDocument;
  impersonating?: boolean;
}

const LOCK_NAME = 'b4m.auth.refresh';
const CHANNEL_NAME = 'b4m.auth';
/** Same bound the callers used before: a cold Lambda must not hang every queued 401 behind it. */
const REFRESH_TIMEOUT_MS = 10_000;

let inFlight: Promise<RefreshedSession> | null = null;

/** Drop any cached in-flight exchange. Call on identity changes (login, logout, impersonation
 *  swap) so a promise from the previous session can't be awaited by the next one. */
export function resetRefreshCoordinator(): void {
  inFlight = null;
}

/* ------------------------------------------------------------------ cross-tab token propagation */

type RefreshBroadcast = { type: 'refreshed'; accessToken: string; impersonating: boolean };

let channel: BroadcastChannel | null | undefined;

/** Lazily opened, and only where supported - jsdom and older browsers have no BroadcastChannel,
 *  and the coordinator must degrade to in-tab-only rather than throw at import time. */
function getChannel(): BroadcastChannel | null {
  if (channel === undefined) {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;
    channel?.addEventListener('message', event => adoptBroadcast((event as MessageEvent).data));
  }
  return channel;
}

/**
 * Take a sibling tab's freshly minted access token. Guarded rather than unconditional: a tab that
 * is mid-MFA or already torn down has deliberately shed its session, and quietly re-arming it here
 * would resurrect a session the user (or a security path) just ended.
 */
function adoptBroadcast(message: unknown): void {
  const data = message as Partial<RefreshBroadcast> | null;
  if (!data || data.type !== 'refreshed' || typeof data.accessToken !== 'string') return;
  const { mfaPending, expired } = useAccessToken.getState();
  if (mfaPending || expired) return;
  applySession({ accessToken: data.accessToken, impersonating: data.impersonating });
}

/** Start listening for sibling refreshes. Call once per app lifetime (providers.tsx); returns a
 *  disposer. Safe to skip entirely - the coordinator still works, just without free adoption. */
export function listenForSiblingRefresh(): () => void {
  getChannel();
  return () => {
    channel?.close();
    channel = undefined;
  };
}

/* ------------------------------------------------------------------------------ the exchange */

function applySession(session: Pick<RefreshedSession, 'accessToken' | 'impersonating'>): void {
  useAccessToken.getState().setVerifiedSession(session.accessToken);
  // Always written, never left stale: the server is the only durable source of truth for whether
  // this session is still inside an impersonation.
  useAccessToken.getState().setImpersonating(!!session.impersonating);
}

async function withCrossTabLock<T>(run: () => Promise<T>): Promise<T> {
  // Web Locks needs a secure context; where it is missing (older Safari, jsdom) the in-tab single
  // flight still applies and the server's CAS covers the rest, so degrade instead of failing.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return run();
  return locks.request(LOCK_NAME, run);
}

async function exchange(): Promise<RefreshedSession> {
  const before = useAccessToken.getState().accessToken;

  return withCrossTabLock(async () => {
    // Layer 2: while we queued for the lock, this tab's token may have been replaced - either by a
    // sibling's broadcast or by an earlier flight in this tab. Nothing left to do.
    const current = useAccessToken.getState().accessToken;
    if (current && current !== before) return { accessToken: current };

    // A pre-cookie session still holds its refresh token in localStorage; send it once with
    // `cookie: true` so the server migrates it onto a cookie instead of logging the user out.
    const legacy = takeLegacyRefreshToken();

    const { data } = await api.post<RefreshedSession>(
      '/api/auth/refreshToken',
      legacy ? { token: legacy, cookie: true } : {},
      {
        // skipAuthRefresh: a 401 here means "no session", not "refresh me". Letting the 401
        // interceptor react would recurse straight back into this function.
        skipAuthRefresh: true,
        timeout: REFRESH_TIMEOUT_MS,
      }
    );

    applySession(data);
    getChannel()?.postMessage({
      type: 'refreshed',
      accessToken: data.accessToken,
      impersonating: !!data.impersonating,
    } satisfies RefreshBroadcast);
    return data;
  });
}

/**
 * Exchange the refresh cookie for a fresh access token, deduplicated across every caller in every
 * tab. Resolves with the live session (the access-token store is already updated); rejects with the
 * axios error so callers can distinguish a rejected credential (400/401) from a transient outage.
 */
export function refreshSession(): Promise<RefreshedSession> {
  if (inFlight) return inFlight;
  const flight = exchange().finally(() => {
    // Guard the identity: resetRefreshCoordinator may have already cleared it for a new session.
    if (inFlight === flight) inFlight = null;
  });
  inFlight = flight;
  return flight;
}
