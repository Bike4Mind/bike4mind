import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IUserDocument } from '@bike4mind/common';
import { useUser, migrateUserContext, UserContextProps, resolveIdentifyEffect } from './UserContext';

// UserProvider is not exercised here - mock its heavier transitive imports so
// importing the module only constructs the zustand store.
vi.mock('../components/ExpiredSession', () => ({ default: () => null }));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetIdentify: vi.fn(),
  useReturnTokenValidation: vi.fn(),
}));

// Minimal stand-in for a user record. The store actions only read `tags`,
// `isAdmin`, `isBanned`, `isModerated` - all optional-chained downstream.
const fakeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({ id: 'u1', name: 'Test User', ...overrides }) as unknown as IUserDocument;

describe('migrateUserContext', () => {
  it('nulls currentUser for a v0 blob (version undefined)', () => {
    const result = migrateUserContext({ currentUser: { id: 'u1' } }, undefined);
    expect(result.currentUser).toBeNull();
  });

  it('nulls currentUser for a v1 blob', () => {
    const result = migrateUserContext({ currentUser: { id: 'u1' } }, 1);
    expect(result.currentUser).toBeNull();
  });

  it('passes a v2 blob through unchanged', () => {
    const blob = { currentUser: { id: 'u1', preferences: {} } } as unknown as UserContextProps;
    expect(migrateUserContext(blob, 2)).toBe(blob);
  });

  it('handles a null persisted state without throwing', () => {
    expect(migrateUserContext(null, 1).currentUser).toBeNull();
  });
});

describe('resolveIdentifyEffect — mfaPending gate + cross-tab guard + stale-cache guard', () => {
  it('skips the bootstrap while this tab is mid-MFA, even on identify success', () => {
    // The load-bearing gate: local mfaPending must win so the MFA modal isn't unmounted.
    expect(resolveIdentifyEffect({ mfaPending: true, hasToken: true, isSuccess: true, isError: false })).toBe('skip');
  });

  it('skips while mid-MFA even if identify errored', () => {
    expect(resolveIdentifyEffect({ mfaPending: true, hasToken: true, isSuccess: false, isError: true })).toBe('skip');
  });

  it('sets the user on identify success with a live, verified token', () => {
    expect(
      resolveIdentifyEffect({
        mfaPending: false,
        hasToken: true,
        isSuccess: true,
        isError: false,
        tokenMfaPending: false,
      })
    ).toBe('setUser');
    // tokenMfaPending omitted (undefined) is treated as verified.
    expect(resolveIdentifyEffect({ mfaPending: false, hasToken: true, isSuccess: true, isError: false })).toBe(
      'setUser'
    );
  });

  it('restores mfaPending (not setUser) when the live token still carries the mfaPending claim — cross-tab rehydrate', () => {
    expect(
      resolveIdentifyEffect({
        mfaPending: false,
        hasToken: true,
        isSuccess: true,
        isError: false,
        tokenMfaPending: true,
      })
    ).toBe('setMfaPending');
  });

  it('clears the user on a STALE identify success with no live token — MFA cancel / logout (the bypass fix)', () => {
    // useGetIdentify keeps its last success in cache after the token is cleared.
    // Without a live token the session is not authenticated, so it must NOT setUser.
    expect(resolveIdentifyEffect({ mfaPending: false, hasToken: false, isSuccess: true, isError: false })).toBe(
      'clearUser'
    );
    // Even if the stale cache's token decoded as mfaPending, no live token wins.
    expect(
      resolveIdentifyEffect({
        mfaPending: false,
        hasToken: false,
        isSuccess: true,
        isError: false,
        tokenMfaPending: true,
      })
    ).toBe('clearUser');
  });

  it('clears the user on identify error', () => {
    expect(resolveIdentifyEffect({ mfaPending: false, hasToken: true, isSuccess: false, isError: true })).toBe(
      'clearUser'
    );
  });

  it('skips while identify is still loading (neither success nor error)', () => {
    expect(resolveIdentifyEffect({ mfaPending: false, hasToken: true, isSuccess: false, isError: false })).toBe('skip');
  });
});

describe('useUser store — isHydrated flag', () => {
  beforeEach(() => {
    localStorage.clear();
    useUser.setState({ currentUser: null, isHydrated: false });
  });

  it('starts false', () => {
    expect(useUser.getState().isHydrated).toBe(false);
  });

  it('flips to true when setCurrentUser is called with a non-null user', () => {
    useUser.getState().setCurrentUser(fakeUser());
    expect(useUser.getState().isHydrated).toBe(true);
  });

  it('stays false when setCurrentUser is called with null', () => {
    useUser.getState().setCurrentUser(null);
    expect(useUser.getState().isHydrated).toBe(false);
  });

  it('stays latched true after a later setCurrentUser(null)', () => {
    useUser.getState().setCurrentUser(fakeUser());
    expect(useUser.getState().isHydrated).toBe(true);

    useUser.getState().setCurrentUser(null);
    // Latched: a transient null (e.g. a WebSocket reset) must not re-flash gates.
    expect(useUser.getState().isHydrated).toBe(true);
  });

  // P0-B abuse gate: aupAcceptedVersion MUST survive persist, or the sync router
  // `beforeLoad` consent guard reads a rehydrated user missing the field, treats an
  // already-consented user as un-consented, and flashes the /accept-policies interstitial on every
  // hard reload until /api/identify refetches. Guards the persisted-field whitelist regression.
  it('persists aupAcceptedVersion so the consent guard does not re-flash on reload', () => {
    useUser.getState().setCurrentUser(fakeUser({ aupAcceptedVersion: 'v1' }));
    const persisted = JSON.parse(localStorage.getItem('user-context') as string);
    expect(persisted.state.currentUser.aupAcceptedVersion).toBe('v1');
  });
});
