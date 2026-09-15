import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** localStorage key used by Zustand persist - referenced by cross-tab logout listener.
 *  NOTE: no credential is written here any more. Only the non-sensitive session-state flags
 *  (hasSession / expired / expiredReason) are persisted; the access token lives in memory and
 *  the refresh token lives in an HttpOnly cookie (server/auth/refreshCookie.ts). */
export const ACCESS_TOKEN_STORAGE_KEY = 'access-token-storage';

/**
 * One-shot carrier for a refresh token left in localStorage by a pre-cookie session.
 *
 * Sessions created before the refresh token moved into an HttpOnly cookie persisted it here.
 * The persist `migrate` below strips it (that is the whole point), but dropping it outright
 * would sign every existing user out on deploy - so it is lifted into memory on the way past
 * and handed to the bootstrap refresh once, which exchanges it for a cookie. Read via
 * takeLegacyRefreshToken(), which also clears it so it can never be replayed.
 */
let legacyRefreshToken: string | null = null;

/** Consume the pre-cookie refresh token, if this browser had one. Single-use. */
export function takeLegacyRefreshToken(): string | null {
  const token = legacyRefreshToken;
  legacyRefreshToken = null;
  return token;
}

/** Why a session ended, when it ended involuntarily. 'expired' = a failed mid-session
 *  refresh; 'revoked' = a security-forced logout (e.g. 3-strike MFA lockout). null while
 *  authenticated or after a voluntary logout. Cross-tab consumers map this to a /login
 *  message via crossTabLogout. */
export type ExpiredSessionReason = 'expired' | 'revoked';

/** Exactly what reaches localStorage - see `partialize`. No credential is a member of this
 *  type, and none should ever become one. crossTabLogout.ts reads the same shape. */
export interface PersistedSessionState {
  hasSession: boolean;
  expired: boolean;
  expiredReason: ExpiredSessionReason | null;
}

/**
 * Global state for the access token.
 * For now, this is only used on websocket messages.
 */
export const useAccessToken = create<{
  /** In-memory ONLY (never persisted): a page reload re-obtains it via the bootstrap silent
   *  refresh, which exchanges the HttpOnly refresh cookie. Kept in JS rather than a cookie
   *  because the WebSocket lives on a different registrable domain and authenticates with
   *  `?token=<accessToken>`, which a cookie cannot reach. */
  accessToken: string | null;
  /** True while the active session belongs to a user an admin is impersonating. Derived from
   *  the server (`impersonating` on the loginAs / refresh / identify responses) because the
   *  admin's own credentials are no longer held client-side - they are parked in the HttpOnly
   *  return cookie and restored by POST /api/auth/returnToAdmin. */
  impersonating: boolean;
  /** Persisted, non-sensitive: "this browser believes it has a session". The cross-tab logout
   *  listener needs a durable flag to tell "the other tab logged out" from "the other tab is
   *  still signed in", a job the persisted accessToken used to do. Deliberately NOT used to
   *  decide whether to attempt the bootstrap refresh: WebKit ITP evicts localStorage after
   *  ~7 days while leaving the server-set cookie intact, and gating on this flag would
   *  reintroduce exactly the mobile-Safari logout this design removes. */
  hasSession: boolean;
  /** True when the stored tokens are mfaPending (pre-MFA-verification).
   *  UserProvider gates setCurrentUser on this flag so /api/identify responses
   *  with mfaPending tokens don't populate currentUser prematurely.
   *  @see UserContext.tsx - the setCurrentUser effect early-returns when this is true.
   *  Not persisted (see partialize below): it's a transient, tab-owned flag. */
  mfaPending: boolean;
  setAccessToken: (token: string | null) => void;
  setImpersonating: (value: boolean) => void;
  resetTokens: () => void;
  /** Store the short-lived access token for an in-flight MFA login (pre-verification). Sets
   *  mfaPending: true so UserProvider won't populate currentUser from /api/identify yet. The
   *  mfaPending stage issues no refresh token or cookie at all (prevents the MFA-bypass path
   *  where a refresh exchange skips the second factor). */
  setMfaPendingTokens: (accessToken: string) => void;
  /** Store a fully-verified session's access token. The matching refresh token was set as an
   *  HttpOnly cookie by the login endpoint and is never seen here. Clears mfaPending so
   *  UserProvider can bootstrap. */
  setVerifiedSession: (accessToken: string) => void;
  /** Set just the mfaPending flag (e.g. cross-tab rehydrate where the server's identify
   *  response is authoritative - see UserContext.tsx). */
  setMfaPending: (value: boolean) => void;
  /** Clear the session for a forced logout (3-strike MFA lockout). Distinct from resetTokens():
   *  sets expired: true (the session was revoked, not voluntarily ended) while still clearing
   *  mfaPending explicitly. Named so this clear path can't silently drop the invariant.
   *  The impersonating flag is deliberately left alone: an MFA lockout is the impersonated
   *  user's MFA failing, not the admin's, and the admin's return cookie is still valid. */
  forceLogoutTokens: () => void;
  /** Clear the session AND set expired: true in a single atomic write - used by the API 401
   *  interceptor when a mid-session refresh fails. Unlike resetTokens() it sets expired: true.
   *  One set() = one persisted write = one cross-tab storage event carrying the final
   *  expired: true payload, so background tabs never observe a transient expired: false and
   *  race to a plain /login. */
  markSessionExpired: () => void;
  /** Like markSessionExpired but stamps expiredReason: 'revoked'. Used for a hard server-side
   *  revocation - e.g. the tokenVersion kill-switch. */
  markSessionRevoked: () => void;
  expired: boolean;
  /** Why the session ended, persisted so a background tab's cross-tab listener
   *  (resolveCrossTabRedirect) can pick the right /login message: 'expired' for a
   *  failed mid-session refresh (markSessionExpired), 'revoked' for a security-forced
   *  logout (the 3-strike MFA lockout via forceLogoutTokens, or the server-side
   *  tokenVersion kill-switch via markSessionRevoked). null for a voluntary logout or a
   *  fresh store. Only read when expired === true. */
  expiredReason: ExpiredSessionReason | null;
}>()(
  persist(
    set => ({
      accessToken: null,
      impersonating: false,
      hasSession: false,
      mfaPending: false,
      expired: true,
      expiredReason: null,
      setAccessToken: token => {
        set({ accessToken: token, hasSession: !!token, expired: false, expiredReason: null });
      },
      setImpersonating: value => {
        set({ impersonating: value });
      },
      resetTokens: () => {
        set({
          accessToken: null,
          impersonating: false,
          hasSession: false,
          mfaPending: false,
          expired: false,
          expiredReason: null,
        });
      },
      setMfaPendingTokens: accessToken => {
        // hasSession stays false: mfaPending has no refresh cookie behind it, so there is no
        // session for another tab to converge on until the second factor clears.
        set({ accessToken, expired: false, mfaPending: true, expiredReason: null });
      },
      setVerifiedSession: accessToken => {
        set({ accessToken, hasSession: true, expired: false, mfaPending: false, expiredReason: null });
      },
      setMfaPending: value => {
        set({ mfaPending: value });
      },
      forceLogoutTokens: () => {
        set({ accessToken: null, hasSession: false, expired: true, mfaPending: false, expiredReason: 'revoked' });
      },
      markSessionExpired: () => {
        set({
          accessToken: null,
          impersonating: false,
          hasSession: false,
          mfaPending: false,
          expired: true,
          expiredReason: 'expired',
        });
      },
      markSessionRevoked: () => {
        set({
          accessToken: null,
          impersonating: false,
          hasSession: false,
          mfaPending: false,
          expired: true,
          expiredReason: 'revoked',
        });
      },
    }),
    {
      name: ACCESS_TOKEN_STORAGE_KEY,
      // NO CREDENTIAL IS PERSISTED. The access token is memory-only (a reload re-obtains it via
      // the bootstrap silent refresh) and the refresh token is an HttpOnly cookie the page can
      // never read. What remains are the flags the cross-tab logout listener reads
      // (crossTabLogout.ts): whether a session is believed active, and if it ended, why.
      // mfaPending is excluded as before: it's a transient, tab-owned flag for an in-flight MFA
      // login; surviving a reload would leave UserProvider permanently gating setCurrentUser
      // (see UserContext.tsx), stranding the account in a half-bootstrapped state.
      partialize: state => ({
        hasSession: state.hasSession,
        expired: state.expired,
        expiredReason: state.expiredReason,
      }),
      // v1 drops the four persisted credentials (accessToken / refreshToken / returnToken /
      // returnRefreshToken). partialize alone is not enough: persist REHYDRATES whatever is in
      // storage, so without this a stale access token from a pre-upgrade session would be
      // loaded back into the store and used until the server rejected it. The refresh token is
      // lifted out first so the bootstrap refresh can trade it for a cookie instead of the
      // upgrade logging everyone out.
      version: 1,
      migrate: persisted => {
        const state = (persisted ?? {}) as Partial<PersistedSessionState> & { refreshToken?: string | null };
        if (typeof state.refreshToken === 'string' && state.refreshToken.length > 0) {
          legacyRefreshToken = state.refreshToken;
        }
        return {
          hasSession: state.hasSession ?? !!legacyRefreshToken,
          expired: state.expired ?? true,
          expiredReason: state.expiredReason ?? null,
        };
      },
    }
  )
);

/**
 * True only when a fully-verified session is active: an access token is present
 * AND the session is not mid-MFA. App-shell data queries gate their `enabled` on
 * this so they don't fire the doomed 401 storm during the login mfaPending window
 * (#804) - the server rejects every non-allowlisted request while mfaPending
 * (see server/auth/auth.ts). A mfaPending login DOES carry an access token, so a
 * bare `!!accessToken` check is not enough. Reactive: flips true the instant MFA
 * verification clears mfaPending, so gated queries auto-run with no manual refetch.
 */
export const useIsFullyAuthenticated = (): boolean => useAccessToken(s => !!s.accessToken && !s.mfaPending);
