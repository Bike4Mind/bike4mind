import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEntitlementGate } from './useEntitlementGate';

const mockUseUser = vi.fn();
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => mockUseUser(),
}));

const mockUserIsDeveloper = vi.fn();
vi.mock('@client/app/utils/user', () => ({
  userIsDeveloper: (user: unknown) => mockUserIsDeveloper(user),
}));

const mockUseEntitlements = vi.fn();
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: (options: { enabled?: boolean }) => mockUseEntitlements(options),
}));

/** Query-state shorthands matching the RestrictedPage test conventions. */
const entitlementsQuery = {
  success: (entitlements: string[]) => ({ data: entitlements, isSuccess: true, isError: false }),
  pending: () => ({ data: undefined, isSuccess: false, isError: false }),
  error: () => ({ data: undefined, isSuccess: false, isError: true }),
};

const learner = { id: 'u1', isAdmin: false, tags: [] as string[] };

describe('useEntitlementGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({ currentUser: learner });
    mockUserIsDeveloper.mockReturnValue(false);
    mockUseEntitlements.mockReturnValue(entitlementsQuery.pending());
  });

  it('returns undefined state (no requirement) when no key is passed', () => {
    const { result } = renderHook(() => useEntitlementGate());

    expect(result.current.state).toBeUndefined();
    expect(mockUseEntitlements).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('satisfied when the server-resolved entitlements include the key', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success(['someproduct:pro']));

    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('satisfied');
  });

  it('normalizes the required key before comparing', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success(['someproduct:pro']));

    const { result } = renderHook(() => useEntitlementGate('  SomeProduct:PRO '));

    expect(result.current.state).toBe('satisfied');
  });

  it('denied when the resolved entitlements lack the key', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.success(['other:pro']));

    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('denied');
  });

  it('pending while the entitlement query is in flight', () => {
    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('pending');
  });

  it('fails open on a query error (UX gate, not a security control)', () => {
    mockUseEntitlements.mockReturnValue(entitlementsQuery.error());

    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('satisfied');
  });

  it('admins bypass without fetching entitlements', () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'a1', isAdmin: true, tags: [] } });

    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('satisfied');
    expect(result.current.bypass).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('developers bypass without fetching entitlements', () => {
    mockUserIsDeveloper.mockReturnValue(true);

    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('satisfied');
    expect(result.current.bypass).toBe(true);
    expect(mockUseEntitlements).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('no user: pending (query disabled), no bypass', () => {
    mockUseUser.mockReturnValue({ currentUser: null });

    const { result } = renderHook(() => useEntitlementGate('someproduct:pro'));

    expect(result.current.state).toBe('pending');
    expect(result.current.bypass).toBe(false);
    expect(mockUseEntitlements).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
