import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminTab } from '../adminSidebarConfig';
import { adminTabToSlug } from '../adminTabSlugs';
import { VISIT_DWELL_MS, useRecordAdminTabVisit } from './useRecordAdminTabVisit';

const { recordVisit, userState } = vi.hoisted(() => ({
  recordVisit: vi.fn(),
  userState: { currentUser: { id: 'user-1' } as { id: string } | null },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (state: typeof userState) => unknown) => select(userState),
}));
vi.mock('./adminPageVisits', () => ({
  useAdminPageVisits: (select: (state: { recordVisit: typeof recordVisit }) => unknown) => select({ recordVisit }),
}));

describe('useRecordAdminTabVisit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recordVisit.mockClear();
    userState.currentUser = { id: 'user-1' };
  });
  afterEach(() => vi.useRealTimers());

  it('records the visit only after the dwell time', () => {
    renderHook(() => useRecordAdminTabVisit(AdminTab.Revenue));
    vi.advanceTimersByTime(VISIT_DWELL_MS - 1);
    expect(recordVisit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recordVisit).toHaveBeenCalledExactlyOnceWith('user-1', adminTabToSlug(AdminTab.Revenue));
  });

  it('does not record a tab that was left before the dwell time', () => {
    const { rerender } = renderHook(({ tab }) => useRecordAdminTabVisit(tab), {
      initialProps: { tab: AdminTab.Revenue },
    });
    vi.advanceTimersByTime(VISIT_DWELL_MS - 1);
    rerender({ tab: AdminTab.Feedback });
    vi.advanceTimersByTime(VISIT_DWELL_MS);
    expect(recordVisit).toHaveBeenCalledExactlyOnceWith('user-1', adminTabToSlug(AdminTab.Feedback));
  });

  it('skips the dashboard tab', () => {
    renderHook(() => useRecordAdminTabVisit(AdminTab.Dashboard));
    vi.advanceTimersByTime(VISIT_DWELL_MS * 2);
    expect(recordVisit).not.toHaveBeenCalled();
  });

  it('skips a non-tab string', () => {
    renderHook(() => useRecordAdminTabVisit('some-detail-route'));
    vi.advanceTimersByTime(VISIT_DWELL_MS * 2);
    expect(recordVisit).not.toHaveBeenCalled();
  });

  it('skips when there is no user id', () => {
    userState.currentUser = null;
    renderHook(() => useRecordAdminTabVisit(AdminTab.Revenue));
    vi.advanceTimersByTime(VISIT_DWELL_MS * 2);
    expect(recordVisit).not.toHaveBeenCalled();
  });
});
