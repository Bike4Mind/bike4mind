import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// `useMeetingsAccess` reads the user store via selectors, so the mock applies the selector
// to a mutable state object the tests reassign per case. Same shape as opti.test.ts.
const { userState } = vi.hoisted(() => ({
  userState: { currentUser: null as Record<string, unknown> | null, isAdmin: false },
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: typeof userState) => unknown) => (selector ? selector(userState) : userState),
}));

// The entitlement query is the async arm. `userIsDeveloper` is left REAL so the developer
// bypass exercises the shared predicate rather than a stub.
const mockUseEntitlements = vi.fn();
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: (options?: { enabled?: boolean }) => mockUseEntitlements(options),
}));

// A build WITH the overlay mounted. The no-overlay case has its own suite below, because it
// is the one that has to hold on the open-core build where the route does not exist at all.
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  premiumRoutes: [{ path: '/meetings', lazyImport: async () => ({ default: () => null }) }],
}));

import { useMeetingsAccess } from './meetings';

const setUser = (currentUser: Record<string, unknown> | null, isAdmin = false) => {
  userState.currentUser = currentUser;
  userState.isAdmin = isAdmin;
};

describe('useMeetingsAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEntitlements.mockReturnValue({ data: undefined });
    setUser({ id: 'u1', tags: [] });
  });

  /**
   * The synchronous arm, and the reason it exists rather than a bare entitlement check.
   *
   * Admin and developer resolve from already-loaded user state, so the rail row is correct on
   * the first paint. A bare entitlement check returns false until `/api/entitlements` lands,
   * which shows an administrator a rail with no row and then makes one appear - indistinguishable
   * from a broken build at exactly the moment somebody is checking whether the overlay mounted.
   */
  it('admin grants synchronously and skips the entitlement fetch', () => {
    setUser({ id: 'a1', tags: [] }, true);
    const { result } = renderHook(() => useMeetingsAccess());
    expect(result.current).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: false });
  });

  it('a developer-tagged user grants synchronously and skips the fetch', () => {
    setUser({ id: 'd1', tags: ['developer'] });
    const { result } = renderHook(() => useMeetingsAccess());
    expect(result.current).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: false });
  });

  it('grants a tag-less holder of the entitlement, through the async arm', () => {
    mockUseEntitlements.mockReturnValue({ data: ['meetings:pro'] });
    const { result } = renderHook(() => useMeetingsAccess());
    expect(result.current).toBe(true);
    // The fetch IS enabled here: nothing in loaded user state could have answered.
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: true });
  });

  it('denies an ordinary user with no entitlement', () => {
    mockUseEntitlements.mockReturnValue({ data: ['some:other'] });
    const { result } = renderHook(() => useMeetingsAccess());
    expect(result.current).toBe(false);
  });

  // Hidden, not granted, while the fetch is in flight. The opposite default would flash the
  // row at every signed-in user on every page load.
  it('denies while entitlements are still loading', () => {
    mockUseEntitlements.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useMeetingsAccess());
    expect(result.current).toBe(false);
  });
});

/**
 * The open-core build, where the overlay is absent and there is no `/meetings` route.
 *
 * This is the case that matters most in this repo: without it an admin on a build with no
 * overlay gets a rail row that navigates to a route the router does not have. `vi.resetModules`
 * is needed because the route-exists check is module-scope - it is evaluated once at import,
 * which is deliberate (the generated route list cannot change at runtime).
 */
describe('useMeetingsAccess with no overlay mounted', () => {
  beforeEach(() => vi.resetModules());

  it('denies even an admin, because the route does not exist', async () => {
    vi.doMock('@client/app/premium-generated/premiumRoutes.generated', () => ({ premiumRoutes: [] }));
    const { useMeetingsAccess: hook } = await import('./meetings');
    setUser({ id: 'a1', tags: ['developer'] }, true);
    const { result } = renderHook(() => hook());
    expect(result.current).toBe(false);
    // And it does not even ask, which is the half that keeps an open-core build from making a
    // request for an entitlement it could never use.
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: false });
  });
});
