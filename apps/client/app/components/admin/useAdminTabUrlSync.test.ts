import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { AdminTab } from './adminSidebarConfig';
import { useAdminTabUrlSync, type IsAdminTabRenderable } from './useAdminTabUrlSync';

const routerMock = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  pathname: '/admin',
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => routerMock.search,
  useLocation: () => ({ pathname: routerMock.pathname }),
  useNavigate: () => routerMock.navigate,
}));

type TabValue = AdminTab | string | null;

function useHarness(initialTab: TabValue, isRenderable?: IsAdminTabRenderable) {
  const [activeTab, setActiveTab] = useState<TabValue>(initialTab);
  useAdminTabUrlSync(activeTab, setActiveTab, isRenderable);
  return { activeTab, setActiveTab };
}

const lastNavigation = () => routerMock.navigate.mock.calls.at(-1)[0];

const gatedOffLiveOps: IsAdminTabRenderable = tab => tab !== AdminTab.LiveOpsTriage;

describe('useAdminTabUrlSync', () => {
  beforeEach(() => {
    routerMock.search = {};
    routerMock.pathname = '/admin';
    routerMock.navigate.mockClear();
  });

  it('writes the active tab when the URL names none', () => {
    renderHook(() => useHarness(AdminTab.Users));

    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    const { to, replace, search } = lastNavigation();
    expect(to).toBe('/admin');
    expect(replace).toBe(true);
    expect(search({})).toEqual({ tab: 'users' });
  });

  it('writes the slug of a tab selected after mount', () => {
    const { result } = renderHook(() => useHarness(AdminTab.Users));
    routerMock.navigate.mockClear();

    act(() => result.current.setActiveTab(AdminTab.Analytics));

    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    expect(lastNavigation().search({ tab: 'users' }).tab).toBe('analytics');
  });

  it('applies a deep-linked tab instead of the store default', () => {
    routerMock.search = { tab: 'llm-dashboard' };

    const { result } = renderHook(() => useHarness(AdminTab.Users));

    expect(result.current.activeTab).toBe(AdminTab.LLMDashboard);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // Mount effects run twice in development; a first-run flag would let the store default
  // overwrite the deep link on the second pass.
  it('keeps a deep link on StrictMode double-run', () => {
    routerMock.search = { tab: 'llm-dashboard' };

    const { result } = renderHook(() => useHarness(AdminTab.Users), { wrapper: StrictMode });

    expect(result.current.activeTab).toBe(AdminTab.LLMDashboard);
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('preserves emergency_access while writing the tab', () => {
    routerMock.search = { emergency_access: 'true' };

    renderHook(() => useHarness(AdminTab.Users));

    expect(lastNavigation().search({ emergency_access: 'true' })).toEqual({
      emergency_access: 'true',
      tab: 'users',
    });
  });

  it('keeps feedbackId on the Feedback tab and drops it elsewhere', () => {
    routerMock.search = { feedbackId: 'abc' };
    const { result } = renderHook(() => useHarness(AdminTab.Feedback));

    expect(lastNavigation().search({ feedbackId: 'abc' })).toEqual({ tab: 'feedback', feedbackId: 'abc' });

    routerMock.navigate.mockClear();
    act(() => result.current.setActiveTab(AdminTab.Users));

    expect(lastNavigation().search({ tab: 'feedback', feedbackId: 'abc' })).toEqual({ tab: 'users' });
  });

  it('corrects a slug that names no known tab', () => {
    routerMock.search = { tab: 'not-a-tab' };

    const { result } = renderHook(() => useHarness(AdminTab.Analytics));

    expect(result.current.activeTab).toBe(AdminTab.Analytics);
    expect(lastNavigation().search({ tab: 'not-a-tab' }).tab).toBe('analytics');
  });

  it('leaves a URL that already names the active tab alone', () => {
    routerMock.search = { tab: 'analytics' };

    renderHook(() => useHarness(AdminTab.Analytics));

    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  // The admin page is embedded in a session surface, whose navigation buttons navigate to a
  // bare /admin; without this the param disappears from under an unchanged store.
  it('restores the tab when the URL loses it after mount', () => {
    routerMock.search = { tab: 'analytics' };
    const { rerender } = renderHook(() => useHarness(AdminTab.Analytics));
    expect(routerMock.navigate).not.toHaveBeenCalled();

    routerMock.search = {};
    rerender();

    expect(lastNavigation().search({}).tab).toBe('analytics');
  });

  it('writes nothing while mounted off the admin route', () => {
    routerMock.pathname = '/profile';

    renderHook(() => useHarness(AdminTab.Users));

    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('ignores a deep link to a tab the console cannot render', () => {
    routerMock.search = { tab: 'live-ops-triage' };

    const { result } = renderHook(() => useHarness(AdminTab.Users, gatedOffLiveOps));

    expect(result.current.activeTab).toBe(AdminTab.Users);
    expect(lastNavigation().search({ tab: 'live-ops-triage' }).tab).toBe('users');
  });

  // The gate can resolve after a deep link has already selected the tab.
  it('falls back to Users when the selected tab stops being renderable', () => {
    routerMock.search = { tab: 'live-ops-triage' };
    const { result, rerender } = renderHook(
      ({ gated }: { gated: boolean }) => useHarness(AdminTab.LiveOpsTriage, gated ? gatedOffLiveOps : undefined),
      { initialProps: { gated: false } }
    );
    expect(result.current.activeTab).toBe(AdminTab.LiveOpsTriage);

    rerender({ gated: true });

    expect(result.current.activeTab).toBe(AdminTab.Users);
    expect(lastNavigation().search({}).tab).toBe('users');
  });
});
