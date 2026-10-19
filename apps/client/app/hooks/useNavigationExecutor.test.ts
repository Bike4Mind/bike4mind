import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNavigationExecutor } from './useNavigationExecutor';
import { useOptiNavigation } from './useOptiNavigation';
import { AdminTab } from '@client/app/components/admin/adminSidebarConfig';

const { mockNavigate, mockSetActiveTab } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockSetActiveTab: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('@client/app/components/admin/useAdminModal', () => ({
  useAdminModal: (selector: (s: unknown) => unknown) => selector({ setActiveTab: mockSetActiveTab }),
}));

vi.mock('@client/app/components/Files/Browser', () => ({
  useFileBrowser: (selector: (s: unknown) => unknown) => selector({ setOpen: vi.fn() }),
}));

// The executor no-ops on Opti intents unless an /opti route is present, and the
// open-core route table is empty - so the overlay's route has to be stood in for.
vi.mock('@client/app/premium-generated/premiumRoutes.generated', () => ({
  premiumRoutes: [{ path: '/opti' }],
}));

const optiIntent = (target: string) =>
  ({ navigationType: 'action', target }) as Parameters<ReturnType<typeof useNavigationExecutor>>[0];

describe('useNavigationExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOptiNavigation.getState().clearPending();
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(false);
  });

  it('marks an Opti click as user-initiated so the surface does not drop it as a replay', () => {
    const { result } = renderHook(() => useNavigationExecutor());
    result.current(optiIntent('scheduling.solvers'));

    const { pendingFamily, pendingSubTab, pendingUserInitiated } = useOptiNavigation.getState();
    expect(pendingFamily).toBe('scheduling');
    expect(pendingSubTab).toBe('solvers');
    expect(pendingUserInitiated).toBe(true);
  });

  // router-core hands a plain `search` object through untouched, so naming mode as a
  // literal would drop every other param on the way to /opti - losing `article`
  // outright, since nothing downstream puts it back.
  it('merges mode into the existing search params instead of replacing them', () => {
    const { result } = renderHook(() => useNavigationExecutor());
    result.current(optiIntent('scheduling'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    const { to, search } = mockNavigate.mock.calls[0][0];
    expect(to).toBe('/opti');
    expect(typeof search).toBe('function');
    expect(search({ mode: 'canvas', session: 'abc', article: 'xyz' })).toEqual({
      mode: 'optimize',
      session: 'abc',
      article: 'xyz',
    });
  });

  // A host that shows the console inside its own pane is already the view the
  // user is looking at, and it owns the way back out. Naming the standalone view
  // here would unmount that host mid-click and strand them there.
  it('leaves the view alone when a host has claimed the console in place', () => {
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(true);
    const { result } = renderHook(() => useNavigationExecutor());
    result.current(optiIntent('assignment.solvers'));

    expect(mockNavigate).not.toHaveBeenCalled();
    const { pendingFamily, pendingSubTab, pendingUserInitiated } = useOptiNavigation.getState();
    expect(pendingFamily).toBe('assignment');
    expect(pendingSubTab).toBe('solvers');
    expect(pendingUserInitiated).toBe(true);
  });

  // The claim covers family consoles only; a route intent is a real page change.
  it('still navigates a route intent while a host holds the console claim', () => {
    useOptiNavigation.getState().setHostHandlesFamilyInPlace(true);
    const { result } = renderHook(() => useNavigationExecutor());
    result.current({ navigationType: 'route', target: '/new' } as Parameters<
      ReturnType<typeof useNavigationExecutor>
    >[0]);

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/new' });
  });

  it('selects the admin tab and names its slug in the URL', () => {
    const { result } = renderHook(() => useNavigationExecutor());
    result.current({ navigationType: 'tab', target: String(AdminTab.LLMDashboard) } as Parameters<
      ReturnType<typeof useNavigationExecutor>
    >[0]);

    expect(mockSetActiveTab).toHaveBeenCalledWith(AdminTab.LLMDashboard);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'llm-dashboard' } });
  });

  // A tab intent whose target is not an index still opens the console; it just has no tab to name.
  it('navigates without a slug when the tab target is not an index', () => {
    const { result } = renderHook(() => useNavigationExecutor());
    result.current({ navigationType: 'tab', target: 'not-a-number' } as Parameters<
      ReturnType<typeof useNavigationExecutor>
    >[0]);

    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: undefined } });
  });
});
