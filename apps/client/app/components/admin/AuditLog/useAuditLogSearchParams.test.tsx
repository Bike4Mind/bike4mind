// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditLogFiltersSchema } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  navigateOverride: null as ((...args: unknown[]) => unknown) | null,
  search: {} as Record<string, unknown>,
  pathname: '/admin',
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigateOverride ?? mocks.navigate,
  useSearch: () => mocks.search,
  useRouter: () => routerStub,
}));

const routerStub = {
  state: {
    get location() {
      return { pathname: mocks.pathname };
    },
  },
};

import { useAuditLogSearchParams } from './useAuditLogSearchParams';

type SearchUpdater = (previous: Record<string, unknown>) => Record<string, unknown>;

const lastSearchUpdate = (previous: Record<string, unknown>) => {
  const call = mocks.navigate.mock.calls.at(-1)?.[0] as { search: SearchUpdater; replace: boolean; to: string };
  expect(call.to).toBe('/admin');
  expect(call.replace).toBe(true);
  return call.search(previous);
};

describe('useAuditLogSearchParams', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.search = {};
    mocks.pathname = '/admin';
    mocks.navigateOverride = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses valid filters from the URL and drops invalid ones', () => {
    mocks.search = { category: 'bogus', severity: 'critical', entryId: 'abc' };
    const { result } = renderHook(() => useAuditLogSearchParams());
    expect(result.current.filters).toEqual({ severity: 'critical' });
    expect(result.current.entryId).toBe('abc');
  });

  it('setFilters writes tab=audit-log and removes keys set to undefined', () => {
    mocks.search = { severity: 'critical', entryId: 'abc', other: 'keep' };
    const { result } = renderHook(() => useAuditLogSearchParams());
    act(() => result.current.setFilters({ action: 'user.deleted' }));
    const next = lastSearchUpdate(mocks.search);
    expect(next.tab).toBe('audit-log');
    expect(next.action).toBe('user.deleted');
    expect(next.severity).toBeUndefined();
    expect(next.entryId).toBeUndefined();
    expect(next.other).toBe('keep');
  });

  it('patchFilters merges onto the current filters and clears undefined', () => {
    mocks.search = { severity: 'critical', verb: 'delete' };
    const { result } = renderHook(() => useAuditLogSearchParams());
    act(() => result.current.patchFilters({ verb: undefined, category: 'access' }));
    const next = lastSearchUpdate(mocks.search);
    expect(next.severity).toBe('critical');
    expect(next.category).toBe('access');
    expect(next.verb).toBeUndefined();
  });

  it('openEntry sets and clears entryId', () => {
    const { result } = renderHook(() => useAuditLogSearchParams());
    act(() => result.current.openEntry('e1'));
    expect(lastSearchUpdate({}).entryId).toBe('e1');
    act(() => result.current.openEntry(null));
    expect(lastSearchUpdate({ entryId: 'e1' }).entryId).toBeUndefined();
  });

  it('clears its own params on unmount while still on /admin', () => {
    const { unmount } = renderHook(() => useAuditLogSearchParams());
    unmount();
    vi.runAllTimers();
    const next = lastSearchUpdate({ tab: 'audit-log', entryId: 'x', severity: 'critical', other: 'keep' });
    const clearedFilters = Object.fromEntries(Object.keys(AuditLogFiltersSchema.shape).map(key => [key, undefined]));
    expect(next).toEqual({ ...clearedFilters, tab: undefined, entryId: undefined, other: 'keep' });
  });

  it('does not navigate on unmount once the location has left /admin', () => {
    const { unmount } = renderHook(() => useAuditLogSearchParams());
    mocks.pathname = '/notebooks';
    unmount();
    vi.runAllTimers();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  // A changed dependency replays the effect on the same instance (cleanup, then effect), which is the
  // exact sequence StrictMode's dev double-invoke produces.
  it('keeps deep-link params when the effect is cleaned up and re-run in the same tick', () => {
    mocks.search = { tab: 'audit-log', severity: 'critical' };
    const { result, rerender } = renderHook(() => useAuditLogSearchParams());
    const replacementNavigate = vi.fn();
    mocks.navigateOverride = replacementNavigate;
    rerender();
    vi.runAllTimers();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(replacementNavigate).not.toHaveBeenCalled();
    expect(result.current.filters).toEqual({ severity: 'critical' });
  });

  it('leaves another tab in place on unmount', () => {
    const { unmount } = renderHook(() => useAuditLogSearchParams());
    unmount();
    vi.runAllTimers();
    expect(lastSearchUpdate({ tab: 'feedback' }).tab).toBe('feedback');
  });
});
