import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { IUserDocument } from '@bike4mind/common';
import React, { ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { userIsAnalyst, userIsCustomer, userIsDeveloper } from '../utils/user';
import { api, isPublicPath } from '@client/app/contexts/ApiContext';
import { buildLoginRedirectUrl } from '@client/app/utils/authRedirect';
import ExpiredSession from '../components/ExpiredSession';
import { useSubscribeCollection } from '../utils/react-query';
import { useGetIdentify, useReturnTokenValidation } from '@client/app/hooks/data/user';
import { persist, PersistStorage, StorageValue } from 'zustand/middleware';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

/**
 * Decode the `tokenVersion` claim from a JWT access token without verifying
 * the signature (client-side only). Returns null only when the token is
 * absent or malformed. A present-but-legacy token (no version claim) returns
 * null too, distinguishable from "no token" only by the caller checking
 * whether a token exists. Every server-side surface (auth.ts, refreshToken.ts,
 * websocket connect.ts) normalizes an absent version to 0 and rejects a
 * legacy token once the user's version is bumped - callers here must do the
 * same rather than exempting legacy tokens from the graceful revoke below.
 */
function decodeTokenVersion(token: string | null): number | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as { tokenVersion?: unknown };
    return typeof payload.tokenVersion === 'number' ? payload.tokenVersion : null;
  } catch {
    return null;
  }
}

/**
 * Decode the `mfaPending` claim from a JWT access token without verifying the
 * signature (client-side only). This claim is the AUTHORITATIVE signal that a
 * session is still mid-MFA: it is embedded in the token, NOT on the
 * `/api/identify` user document (the server never sets `user.mfaPending`). The
 * gate must therefore read it from the token here rather than from the identify
 * response body. Returns false when the token is absent, malformed, or carries
 * no claim.
 */
function decodeMfaPending(token: string | null): boolean {
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as { mfaPending?: unknown };
    return payload.mfaPending === true;
  } catch {
    return false;
  }
}

export interface UserContextProps {
  currentUser: IUserDocument | null;
  /** Explicit, latched hydration flag - flips true the first time a non-null
   *  user is written via setCurrentUser/refreshUser (i.e. from /api/identify,
   *  refreshUser, or a WebSocket push). Never persisted, never reset to false;
   *  a fresh page load starts false until the first real user write lands. */
  isHydrated: boolean;
  isAdmin: boolean;
  isBanned: boolean;
  isModerated: boolean;
  isAnalyst: boolean;
  isDeveloper: boolean;
  isCustomer: boolean;
  setCurrentUser: (value: IUserDocument | null) => void;
  refreshUser: () => Promise<void>;
}

export interface UserProviderProps {
  children: ReactNode;
}

// Helper to detect QuotaExceededError across browsers
// - Chrome/Safari/Edge: error.code === 22
// - Firefox: error.code === 1014 && error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
// - Modern browsers: error.name === 'QuotaExceededError'
const isQuotaExceededError = (error: unknown): boolean => {
  if (!(error instanceof DOMException)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    error.code === 22 ||
    (error.code === 1014 && error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
};

// Safe localStorage wrapper following tagCache.ts pattern
const safeUserStorage = {
  getItem: (name: string): string | null => {
    // SSR safety check (follows TranslationProvider.tsx pattern)
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(name);
    } catch (error) {
      console.warn('👤 [UserContext] Failed to read from localStorage:', error);
      return null;
    }
  },
  setItem: (name: string, value: string): void => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      console.warn('👤 [UserContext] Failed to write to localStorage:', error);
      if (isQuotaExceededError(error)) {
        // Clear the key and retry (follows tagCache.ts pattern)
        try {
          localStorage.removeItem(name);
          localStorage.setItem(name, value);
        } catch {
          // Give up - app continues with memory-only state
          console.error('👤 [UserContext] localStorage quota exceeded, persistence disabled');
        }
      }
    }
  },
  removeItem: (name: string): void => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(name);
    } catch (error) {
      console.warn('👤 [UserContext] Failed to remove from localStorage:', error);
    }
  },
};

// Persist a slim subset of user fields for instant UI rendering on reload
// (~1KB vs potentially MB+). Hydration is tracked by the explicit `isHydrated`
// store flag, not by which fields are present here, so this pick is purely a
// storage-size decision.
//
// `tags` and `preferences` are both persisted so feature gates survive a hard
// refresh: `useGetIdentify` feeds the persisted user back into React Query as
// `initialData` with a 5-min `staleTime`, so `/api/identify` does NOT refetch
// on reload. Persisting `tags` keeps model-access gates (e.g. entitlement- and
// tag-scoped models in `useAccessibleModels`) resolving from the user's real
// tags on reload rather than an empty set; without persisted `preferences`,
// experimental-feature gates render from admin defaults instead of the user's
// real value. Both are small.
type PersistedUserFields = Pick<
  IUserDocument,
  | 'id'
  | 'name'
  | 'email'
  | 'username'
  | 'photoUrl'
  | 'isAdmin'
  | 'level'
  | 'organizationId'
  | 'emailVerified'
  | 'showCreditsUsed'
  | 'currentCredits'
  | 'preferences'
  | 'tags'
  // Persisted so first-run UX (e.g. suppressing "What's New" for brand-new accounts) survives a
  // page reload - otherwise createdAt is undefined after rehydrate and the grace window misfires.
  | 'createdAt'
  // P0-B abuse gate: persisted as a read-only mirror of the server-authoritative field so the
  // consent state is available instantly on rehydrate. The router `beforeLoad` consent guard
  // additionally defers on `!isHydrated` (see shouldRedirectToConsent), so a session that predates
  // this field being persisted still won't flash the /accept-policies interstitial on hard reload -
  // it waits for /api/identify to land the grandfathered value.
  | 'aupAcceptedVersion'
>;

const pickPersistedFields = (user: IUserDocument | null): PersistedUserFields | null => {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    username: user.username,
    photoUrl: user.photoUrl,
    isAdmin: user.isAdmin,
    level: user.level,
    organizationId: user.organizationId,
    emailVerified: user.emailVerified,
    showCreditsUsed: user.showCreditsUsed,
    currentCredits: user.currentCredits,
    preferences: user.preferences,
    tags: user.tags,
    createdAt: user.createdAt,
    aupAcceptedVersion: user.aupAcceptedVersion,
  };
};

// Type for the partialized state that gets persisted
type PersistedState = { currentUser: PersistedUserFields | null };

// Custom storage adapter with error handling
const userContextStorage: PersistStorage<PersistedState> = {
  getItem: (name: string): StorageValue<PersistedState> | null => {
    const value = safeUserStorage.getItem(name);
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      console.warn('👤 [UserContext] Failed to parse stored data, clearing');
      safeUserStorage.removeItem(name);
      return null;
    }
  },
  setItem: (name: string, value: StorageValue<PersistedState>): void => {
    safeUserStorage.setItem(name, JSON.stringify(value));
  },
  removeItem: (name: string): void => {
    safeUserStorage.removeItem(name);
  },
};

/**
 * Persist migration. Versions <2 persisted `currentUser` without `preferences`
 * (it was excluded from pickPersistedFields). Drop the stale stub so a fresh
 * /api/identify repopulates the full user - including preferences - and feature
 * gates hydrate from correct data. `undefined < 2` is false in JS, so the
 * version is coalesced before comparing. Exported for unit testing.
 */
export const migrateUserContext = (persistedState: unknown, version: number | undefined): UserContextProps => {
  if ((version ?? 0) < 2) {
    const state = persistedState as Record<string, unknown> | null;
    return { ...(state ?? {}), currentUser: null } as UserContextProps;
  }
  return persistedState as UserContextProps;
};

export const useUser = create<UserContextProps>()(
  persist(
    set => ({
      currentUser: null,
      isHydrated: false,
      isAdmin: false,
      isBanned: false,
      isModerated: false,
      isAnalyst: false,
      isDeveloper: false,
      isCustomer: false,
      setCurrentUser: (currentUser: IUserDocument | null) => {
        set({
          currentUser,
          // Latch isHydrated on the first non-null user. zustand's `set` merges,
          // so omitting the key when currentUser is null preserves the latch.
          ...(currentUser ? { isHydrated: true } : {}),
          isAdmin: !!currentUser?.isAdmin,
          isBanned: !!currentUser?.isBanned,
          isModerated: !!currentUser?.isModerated,
          isDeveloper: userIsDeveloper(currentUser),
          isAnalyst: userIsAnalyst(currentUser),
          isCustomer: userIsCustomer(currentUser),
        });
      },
      refreshUser: async () => {
        try {
          const response = await api.get<{ user: IUserDocument }>('/api/identify');
          set({
            currentUser: response.data.user,
            isHydrated: true,
            isAdmin: !!response.data.user?.isAdmin,
            isBanned: !!response.data.user?.isBanned,
            isModerated: !!response.data.user?.isModerated,
            isDeveloper: userIsDeveloper(response.data.user),
            isAnalyst: userIsAnalyst(response.data.user),
            isCustomer: userIsCustomer(response.data.user),
          });
        } catch (error) {
          console.error('Error refreshing user:', error);
        }
      },
    }),
    {
      name: 'user-context',
      version: 2, // v2: persisted currentUser now includes `preferences`
      storage: userContextStorage,
      migrate: migrateUserContext,
      partialize: state => ({ currentUser: pickPersistedFields(state.currentUser) }),
    }
  )
);

/**
 * Decide whether a real-time `users` update should force a graceful sign-out
 * (the JWT kill switch): true when the user's DB tokenVersion has advanced
 * past the version embedded in this tab's access token. A legacy token (no
 * embedded version) normalizes to 0, matching every server-side surface
 * (auth.ts, refreshToken.ts, websocket connect.ts) - it must NOT be exempted,
 * or a bumped user keeps a legacy session that 401s on every request with no
 * graceful sign-out. Returns false when there is no access token at all (a
 * logged-out tab has nothing to revoke).
 */
export function shouldRevokeForTokenVersion(params: {
  accessToken: string | null;
  userTokenVersion: unknown;
}): boolean {
  if (!params.accessToken) return false;
  if (typeof params.userTokenVersion !== 'number') return false;
  const effectiveVersion = decodeTokenVersion(params.accessToken) ?? 0;
  return params.userTokenVersion > effectiveVersion;
}

/**
 * Pure decision for UserProvider's /api/identify bootstrap effect. Extracted so the
 * load-bearing mfaPending gate and the cross-tab rehydrate guard are
 * unit-testable without rendering the heavily-wired UserProvider.
 *
 * - local mfaPending (this tab is mid-MFA) -> skip; the MFA modal owns the flow.
 * - identify error -> clear the user.
 * - identify success but NO live token -> clear the user. `useGetIdentify` retains
 *   its last success in cache after the token is cleared (MFA cancelled / logout),
 *   so without this a stale cache would log the user in with no valid token.
 * - identify success + token still carries the mfaPending claim -> restore the flag,
 *   don't populate currentUser (cross-tab rehydrate where the in-memory flag was
 *   lost; the claim is read from the JWT, the authoritative source).
 * - identify success + verified token -> set the user.
 */
export type IdentifyEffectAction = 'skip' | 'setMfaPending' | 'setUser' | 'clearUser';

export function resolveIdentifyEffect(params: {
  mfaPending: boolean;
  hasToken: boolean;
  isSuccess: boolean;
  isError: boolean;
  tokenMfaPending?: boolean;
}): IdentifyEffectAction {
  if (params.mfaPending) return 'skip';
  if (params.isError) return 'clearUser';
  if (!params.isSuccess) return 'skip';
  // identify resolved, but tokens were cleared (MFA cancel / logout) - a stale
  // success cache must never promote to a logged-in state without a live token.
  if (!params.hasToken) return 'clearUser';
  if (params.tokenMfaPending) return 'setMfaPending';
  return 'setUser';
}

/** Provides user data and operations to children via the zustand store. */
export const UserProvider: React.FC<UserProviderProps> = ({ children }) => {
  const [userId, setCurrentUser] = useUser(useShallow(s => [s.currentUser?.id, s.setCurrentUser, s.refreshUser]));
  const [setAccessToken, expired, accessToken, mfaPending, setMfaPending] = useAccessToken(
    useShallow(s => [s.setAccessToken, s.expired, s.accessToken, s.mfaPending, s.setMfaPending])
  );
  const identity = useGetIdentify();
  useReturnTokenValidation();
  const { t } = useTranslation();

  // Real-time subscription updates instead of periodic polling

  // Subscribe to changes in the 'users' collection in the database
  useSubscribeCollection<IUserDocument>(
    'users',
    useMemo(() => (userId ? { _id: userId } : null), [userId]),
    useCallback(
      (_type: string, data: IUserDocument) => {
        if (data && data.id === userId) {
          try {
            setCurrentUser({ ...data });
            // Real-time kill switch: if the user's tokenVersion has advanced
            // past the version embedded in this tab's access token, the session
            // was revoked server-side (password reset / MFA change / unlink) -
            // drop the token and force re-auth. See shouldRevokeForTokenVersion
            // for why a legacy (version-less) token is NOT exempted.
            if (shouldRevokeForTokenVersion({ accessToken, userTokenVersion: data.tokenVersion })) {
              // Session revoked server-side. markSessionRevoked() clears every token
              // (including the impersonation return tokens, so an admin's stashed return
              // credential can't survive a hard revocation) and stamps expiredReason:
              // 'revoked'. Redirect to /login with the session_revoked message so this tab -
              // and background tabs via the cross-tab listener - explain the forced sign-out
              // instead of dropping the user on a bare /login. setCurrentUser(null) is not
              // redundant: the redirect below is guarded by isPublicPath, so on a public
              // page it's skipped and this is what clears the user. Note: this subscription
              // is keyed on the (possibly impersonated) currentUser.id, so if an impersonated
              // user revokes themselves the admin's stashed return token is dropped too, ending
              // "Return to Admin". That's accepted for now (safe over sorry); distinguishing
              // "impersonated user self-revoked" from "admin's own session revoked" is a future
              // enhancement.
              useAccessToken.getState().markSessionRevoked();
              setCurrentUser(null);
              if (!isPublicPath(window.location.pathname)) {
                window.location.replace(buildLoginRedirectUrl('session_revoked', window.location));
              }
            }
          } catch (error) {
            console.error('Error updating user data:', error);
          }
        }
      },
      [setCurrentUser, userId, accessToken]
    ),
    {
      fetchInitialData: true,
      fields: {
        currentCredits: 1,
        lastCreditsPurchasedAt: 1,
        id: 1,
        tokenVersion: 1,
        emailVerified: 1,
        name: 1,
        email: 1,
        username: 1,
        systemFiles: 1,
        showCreditsUsed: 1,
        atlassianConnect: 1,
        googleDrive: 1,
        authProviders: 1,
        // Critical fields for modal filtering and UI
        tags: 1,
        isAdmin: 1,
        level: 1,
        photoUrl: 1,
        organizationId: 1,
        // User presence fields
        isOnline: 1,
        lastActiveAt: 1,
        // Additional user preferences
        preferredVoice: 1,
        preferences: 1,
        // Security and permissions
        mfa: 1,
        groups: 1,
        // Integration settings (subscription replaces currentUser entirely,
        // so slackSettings must be included or it gets wiped on every update)
        slackSettings: 1,
      },
    }
  );

  // Fetch the current user's data and access token when the component mounts.
  // Skip when tokens are mfaPending - /api/identify succeeds with mfaPending
  // tokens but the session isn't fully authenticated yet. Setting currentUser
  // here would trigger redirects that unmount the MFA modal.
  useEffect(() => {
    const action = resolveIdentifyEffect({
      mfaPending,
      hasToken: !!accessToken,
      isSuccess: identity.isSuccess,
      isError: identity.isError,
      tokenMfaPending: decodeMfaPending(accessToken),
    });
    switch (action) {
      case 'setMfaPending':
        // Cross-tab: a tab opened mid-MFA rehydrated mfaPending tokens with mfaPending:false
        // (the flag isn't persisted). The token's mfaPending JWT claim is authoritative.
        setMfaPending(true);
        break;
      case 'setUser':
        if (identity.data) {
          setCurrentUser(identity.data.user);
          setAccessToken(identity.data.accessToken);
        }
        break;
      case 'clearUser':
        setCurrentUser(null);
        break;
      case 'skip':
        break;
    }
  }, [
    identity.isSuccess,
    identity.isError,
    identity.data,
    setCurrentUser,
    setAccessToken,
    mfaPending,
    setMfaPending,
    accessToken,
  ]);

  // Check for Atlassian reconnect status and show toast if needed
  const currentUser = useUser(s => s.currentUser);
  const hasShownAtlassianReconnectToast = useRef(false);
  useEffect(() => {
    const needsReconnect = currentUser?.atlassianConnect?.status === 'needs_reconnect';
    if (needsReconnect && !hasShownAtlassianReconnectToast.current) {
      hasShownAtlassianReconnectToast.current = true;
      toast.error(t('integrations.atlassian.reconnect_required'), {
        duration: 10000,
        action: {
          label: 'Reconnect',
          onClick: () => {
            window.location.href = '/profile?tab=integrations';
          },
        },
      });
    } else if (!needsReconnect) {
      hasShownAtlassianReconnectToast.current = false;
    }
  }, [currentUser?.atlassianConnect?.status, t]);

  // Render children immediately with cached user data from localStorage
  // Fresh data is fetched in background and updates seamlessly when available
  return (
    <div className="user-provider-container">
      {children}
      {expired && accessToken && <ExpiredSession />}
    </div>
  );
};
