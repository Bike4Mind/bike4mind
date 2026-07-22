import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** localStorage key used by Zustand persist - referenced by cross-tab logout listener. */
export const ACCESS_TOKEN_STORAGE_KEY = 'access-token-storage';

/** Why a session ended, when it ended involuntarily. 'expired' = a failed mid-session
 *  refresh; 'revoked' = a security-forced logout (e.g. 3-strike MFA lockout). null while
 *  authenticated or after a voluntary logout. Cross-tab consumers map this to a /login
 *  message via crossTabLogout. */
export type ExpiredSessionReason = 'expired' | 'revoked';

/**
 * Global state for the access token.
 * For now, this is only used on websocket messages.
 */
export const useAccessToken = create<{
  accessToken: string | null;
  refreshToken: string | null;
  returnToken: string | null;
  /** The impersonating admin's refresh token, stashed during loginAs so
   *  "Return to Admin" can restore a consistent admin session. The active
   *  refreshToken is swapped to the impersonated user's, so this must be held
   *  separately rather than relying on refreshToken staying the admin's. */
  returnRefreshToken: string | null;
  /** True when the stored tokens are mfaPending (pre-MFA-verification).
   *  UserProvider gates setCurrentUser on this flag so /api/identify responses
   *  with mfaPending tokens don't populate currentUser prematurely.
   *  @see UserContext.tsx - the setCurrentUser effect early-returns when this is true.
   *  Not persisted (see partialize below): it's a transient, tab-owned flag. */
  mfaPending: boolean;
  setAccessToken: (token: string | null) => void;
  setReturnToken: (token: string | null) => void;
  setReturnRefreshToken: (token: string | null) => void;
  setRefreshToken: (token: string | null) => void;
  resetTokens: () => void;
  /** Store tokens for an in-flight MFA login (pre-verification). Sets mfaPending: true so
   *  UserProvider won't populate currentUser from /api/identify yet.
   *  refreshToken is intentionally optional - the mfaPending stage no longer issues one
   *  (prevents the MFA-bypass path where a refresh exchange skips the second factor). */
  setMfaPendingTokens: (accessToken: string, refreshToken?: string | null) => void;
  /** Store fully-verified session tokens. Clears mfaPending so UserProvider can bootstrap. */
  setVerifiedTokens: (accessToken: string, refreshToken: string) => void;
  /** Set just the mfaPending flag (e.g. cross-tab rehydrate where the server's identify
   *  response is authoritative - see UserContext.tsx). */
  setMfaPending: (value: boolean) => void;
  /** Clear tokens for a forced logout (3-strike MFA lockout). Distinct from resetTokens():
   *  sets expired: true (the session was revoked, not voluntarily ended) while still clearing
   *  mfaPending explicitly. Named so this clear path can't silently drop the invariant.
   *  Deliberately PRESERVES the impersonation returnToken/returnRefreshToken: an MFA lockout is
   *  the impersonated user's MFA failing, not the admin's, so the admin's stashed return session
   *  is still valid and should survive. A hard revocation of the admin's own session uses
   *  markSessionRevoked() instead, which clears those too. Keep this divergence intentional. */
  forceLogoutTokens: () => void;
  /** Clear all tokens AND set expired: true in a single atomic write - used by the API 401
   *  interceptor when a mid-session refresh fails. Like resetTokens() it also clears the
   *  impersonation tokens (returnToken/returnRefreshToken), which forceLogoutTokens() leaves
   *  intact, but unlike resetTokens() it sets expired: true. One set() = one persisted write =
   *  one cross-tab storage event carrying the final expired: true payload, so background tabs
   *  never observe a transient expired: false and race to a plain /login. Clearing the return
   *  tokens is intentional: an admin whose impersonated session can't refresh is sent to /login
   *  rather than popped back to their own session (matches the prior resetTokens behavior;
   *  auto-popping back on a failed refresh is out of scope). */
  markSessionExpired: () => void;
  /** Like markSessionExpired (clears every token, including the impersonation return tokens)
   *  but stamps expiredReason: 'revoked'. Used for a hard server-side revocation - e.g. the
   *  tokenVersion kill-switch - where leaving an admin's stashed return token behind would be
   *  wrong. */
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
      refreshToken: null,
      returnToken: null,
      returnRefreshToken: null,
      mfaPending: false,
      expired: true,
      expiredReason: null,
      setAccessToken: token => {
        set({ accessToken: token, expired: false, expiredReason: null });
      },
      setReturnToken: token => {
        set({ returnToken: token });
      },
      setReturnRefreshToken: token => {
        set({ returnRefreshToken: token });
      },
      setRefreshToken: token => {
        set({ refreshToken: token });
      },
      resetTokens: () => {
        set({
          accessToken: null,
          refreshToken: null,
          returnToken: null,
          returnRefreshToken: null,
          mfaPending: false,
          expired: false,
          expiredReason: null,
        });
      },
      setMfaPendingTokens: (accessToken, refreshToken) => {
        set({ accessToken, refreshToken: refreshToken ?? null, expired: false, mfaPending: true, expiredReason: null });
      },
      setVerifiedTokens: (accessToken, refreshToken) => {
        set({ accessToken, refreshToken, expired: false, mfaPending: false, expiredReason: null });
      },
      setMfaPending: value => {
        set({ mfaPending: value });
      },
      forceLogoutTokens: () => {
        set({ accessToken: null, refreshToken: null, expired: true, mfaPending: false, expiredReason: 'revoked' });
      },
      markSessionExpired: () => {
        set({
          accessToken: null,
          refreshToken: null,
          returnToken: null,
          returnRefreshToken: null,
          mfaPending: false,
          expired: true,
          expiredReason: 'expired',
        });
      },
      markSessionRevoked: () => {
        set({
          accessToken: null,
          refreshToken: null,
          returnToken: null,
          returnRefreshToken: null,
          mfaPending: false,
          expired: true,
          expiredReason: 'revoked',
        });
      },
    }),
    {
      name: ACCESS_TOKEN_STORAGE_KEY,
      // Persist only the durable token fields. mfaPending is a transient,
      // tab-owned flag for an in-flight MFA login; if it survived a reload it
      // would leave UserProvider permanently gating setCurrentUser (see
      // UserContext.tsx), stranding the account in a half-bootstrapped state.
      partialize: state => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        returnToken: state.returnToken,
        returnRefreshToken: state.returnRefreshToken,
        expired: state.expired,
        expiredReason: state.expiredReason,
      }),
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
