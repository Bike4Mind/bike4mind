// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: {} as Record<string, unknown>,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}));

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

  it('clears its own params on unmount', () => {
    const { unmount } = renderHook(() => useAuditLogSearchParams());
    unmount();
    const next = lastSearchUpdate({ tab: 'audit-log', entryId: 'x', severity: 'critical', other: 'keep' });
    expect(next).toEqual({
      tab: undefined,
      entryId: undefined,
      severity: undefined,
      other: 'keep',
      category: undefined,
      action: undefined,
      verb: undefined,
      actorUserId: undefined,
      targetKind: undefined,
      targetId: undefined,
      source: undefined,
      actorScope: undefined,
      from: undefined,
      to: undefined,
      requestId: undefined,
      impersonationSessionId: undefined,
    });
  });

  it('leaves another tab in place on unmount', () => {
    const { unmount } = renderHook(() => useAuditLogSearchParams());
    unmount();
    expect(lastSearchUpdate({ tab: 'feedback' }).tab).toBe('feedback');
  });
});
