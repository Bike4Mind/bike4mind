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
  // Mirrors TanStack's `select`: the hook narrows its subscription to `tab`.
  useSearch: (options?: { select?: (search: Record<string, unknown>) => unknown }) =>
    options?.select ? options.select(routerMock.search) : routerMock.search,
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

    const search = lastNavigation().search({ emergency_access: 'true', redirectTo: '/somewhere' });
    expect(search).toEqual({ emergency_access: 'true', tab: 'users' });
    expect(search).not.toHaveProperty('redirectTo');
  });

  it("keeps only the new tab's registered params on a tab switch", () => {
    routerMock.search = { tab: 'admin-settings', section: 'security', q: 'slack' };
    const { result } = renderHook(() => useHarness(AdminTab.AdminSettings));
    expect(routerMock.navigate).not.toHaveBeenCalled();

    act(() => result.current.setActiveTab(AdminTab.AuditLog));

    const previous = { tab: 'admin-settings', section: 'security', q: 'slack', category: 'credits', entryId: 'e1' };
    expect(lastNavigation().search(previous)).toEqual({ tab: 'audit-log', category: 'credits', entryId: 'e1' });
  });

  it('leaves an Audit Log deep link, filters included, untouched', () => {
    routerMock.search = { tab: 'audit-log', category: 'credits' };

    const { result } = renderHook(() => useHarness(AdminTab.CreditAnalytics));

    expect(result.current.activeTab).toBe(AdminTab.AuditLog);
    expect(routerMock.navigate).not.toHaveBeenCalled();
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

  // The mount guard must not swallow a tab picked after the URL already named one.
  it('writes a newly selected tab while the URL names a different one', () => {
    routerMock.search = { tab: 'users' };
    const { result } = renderHook(() => useHarness(AdminTab.Users));
    expect(routerMock.navigate).not.toHaveBeenCalled();

    act(() => result.current.setActiveTab(AdminTab.Analytics));

    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    const { replace, search } = lastNavigation();
    expect(replace).toBe(true);
    expect(search({ tab: 'users' }).tab).toBe('analytics');
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

    const seen: unknown[] = [];
    const { result } = renderHook(() => {
      const h = useHarness(AdminTab.Users, gatedOffLiveOps);
      seen.push(h.activeTab);
      return h;
    });

    expect(result.current.activeTab).toBe(AdminTab.Users);
    expect(seen).not.toContain(AdminTab.LiveOpsTriage);
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
