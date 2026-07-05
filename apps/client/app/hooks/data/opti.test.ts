import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// `useOptiAccess` reads the user store via selectors (`useUser(s => s.currentUser)`
// / `useUser(s => s.isAdmin)`), so the mock applies the selector to a mutable
// state object the tests reassign per case.
const { userState } = vi.hoisted(() => ({
  userState: { currentUser: null as Record<string, unknown> | null, isAdmin: false },
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector?: (s: typeof userState) => unknown) => (selector ? selector(userState) : userState),
}));

// The entitlement query is the async arm; `userIsDeveloper` is left REAL (it just
// reads tags via the shared predicate) so the developer-bypass case exercises the
// true logic, not a stub.
const mockUseEntitlements = vi.fn();
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: (options?: { enabled?: boolean }) => mockUseEntitlements(options),
}));

import { useOptiAccess } from './opti';

const setUser = (currentUser: Record<string, unknown> | null, isAdmin = false) => {
  userState.currentUser = currentUser;
  userState.isAdmin = isAdmin;
};

describe('useOptiAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseEntitlements.mockReturnValue({ data: undefined });
    setUser({ id: 'u1', tags: [] });
  });

  // --- Synchronous fast path: grant from loaded user state, NO entitlement fetch.
  // These three cases are the first-paint-regression guard: a bare entitlement
  // check would return false until /api/entitlements resolved, briefly hiding the
  // Sidenav entry and routing the logo click off-app.

  it('admin grants synchronously and skips the entitlement fetch', () => {
    setUser({ id: 'a1', tags: [] }, true);
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: false });
  });

  it('a developer-tagged user grants synchronously and skips the fetch', () => {
    setUser({ id: 'd1', tags: ['developer'] });
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: false });
  });

  it('an `Opti`-tagged user grants synchronously and skips the fetch', () => {
    setUser({ id: 'o1', tags: ['opti'] });
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: false });
  });

  it('matches the Opti tag case- and whitespace-insensitively (mirrors normalizeTag)', () => {
    for (const tag of ['Opti', 'OPTI', '  opti  ']) {
      setUser({ id: 'o2', tags: [tag] });
      const { result } = renderHook(() => useOptiAccess());
      expect(result.current, `tag=${JSON.stringify(tag)}`).toBe(true);
    }
  });

  // --- Async arm: tag-less holders (the domain-based entitlement cohort) resolve via the
  // entitlement fetch, which IS enabled for them.

  it('a tag-less holder of the entitlement is granted (fetch enabled)', () => {
    setUser({ id: 'i1', tags: [] });
    mockUseEntitlements.mockReturnValue({ data: ['optihashi:pro'] });
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: true });
  });

  it('a tag-less user is denied while the entitlement query is still loading (no premature grant)', () => {
    setUser({ id: 'i2', tags: [] });
    mockUseEntitlements.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(false);
    expect(mockUseEntitlements).toHaveBeenCalledWith({ enabled: true });
  });

  it('a tag-less user whose entitlements resolve without the key is denied', () => {
    setUser({ id: 'i3', tags: ['customer'] });
    mockUseEntitlements.mockReturnValue({ data: ['other:pro'] });
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(false);
  });

  it('handles a null currentUser without throwing', () => {
    setUser(null);
    mockUseEntitlements.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useOptiAccess());
    expect(result.current).toBe(false);
  });
});
