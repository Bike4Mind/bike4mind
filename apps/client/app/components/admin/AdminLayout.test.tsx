import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminLayoutRoute, isAdminSubscriptionDetailPath, isAdminUserProfilePath } from './AdminLayout';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';

const mockUseUser = vi.fn();

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => mockUseUser() }));
vi.mock('@client/app/utils/user', () => ({ userIsDeveloper: () => false }));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: () => ({ data: undefined, isSuccess: false, isError: false }),
}));
vi.mock('@client/app/contexts/ProviderBundle', () => ({
  ProviderBundle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@client/app/hooks/data/admin', () => ({ useLiveOpsTriageEnv: () => ({ data: { showTab: false } }) }));
vi.mock('@client/app/hooks/data/subscribers', () => ({ useGetWaitingSubscribersCount: () => ({ data: undefined }) }));
vi.mock('./Subscriptions/subscriptionsLastSeen', () => ({ useNewSubscriptionsDot: () => false }));
vi.mock('@client/app/hooks/useHelpKeyboardShortcut', () => ({ useHelpKeyboardShortcut: () => undefined }));
vi.mock('../help', () => ({ HelpPanel: () => null }));

const theme = extendTheme({ ...getThemeConfig() });

const renderAt = async (path: string) => {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const layoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'admin-layout',
    component: () => <AdminLayoutRoute fallback={<div>loading</div>} />,
  });
  const consoleRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/admin',
    component: () => <div data-testid="console-page">console</div>,
  });
  const profileRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/admin/users/$userId',
    component: () => <div data-testid="profile-page">profile</div>,
  });
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/new',
    component: () => <div data-testid="new-page">new</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([layoutRoute.addChildren([consoleRoute, profileRoute]), newRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    render(
      <CssVarsProvider theme={theme}>
        <RouterProvider router={router} />
      </CssVarsProvider>
    );
  });
  return router;
};

const desktopSidebar = () => screen.getAllByTestId('admin-sidebar-nav')[0];

describe('AdminLayoutRoute', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAdminModal.setState({ activeTab: AdminTab.Dashboard });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(['/admin', '/admin/users/0123456789abcdef01234567'])(
    'sends a non-admin on %s to /new without rendering the shell',
    async path => {
      mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: false, tags: [] } });

      const router = await renderAt(path);

      await waitFor(() => expect(router.state.location.pathname).toBe('/new'));
      expect(screen.queryByTestId('admin-layout')).toBeNull();
      expect(screen.queryByTestId('console-page')).toBeNull();
      expect(screen.queryByTestId('profile-page')).toBeNull();
    }
  );

  it('renders the console inside the shell for an admin', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });

    await renderAt('/admin');

    const layout = await screen.findByTestId('admin-layout');
    expect(layout).toHaveAttribute('data-admin-surface');
    expect(within(layout).getByTestId('console-page')).toBeInTheDocument();
    expect(within(desktopSidebar()).getByTestId('admin-dashboard-tab-btn')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the sidebar on a user profile, with Users active', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });

    await renderAt('/admin/users/0123456789abcdef01234567');

    const layout = await screen.findByTestId('admin-layout');
    expect(within(layout).getByTestId('profile-page')).toBeInTheDocument();
    expect(within(desktopSidebar()).getByTestId('admin-users-tab-btn')).toHaveAttribute('aria-current', 'page');
    expect(within(desktopSidebar()).getByTestId('admin-dashboard-tab-btn')).not.toHaveAttribute('aria-current');
  });

  it('leaves a profile for the console tab picked in the sidebar', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });
    const router = await renderAt('/admin/users/0123456789abcdef01234567');

    fireEvent.click(within(desktopSidebar()).getByTestId('admin-organizations-tab-btn'));

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(router.state.location.search).toEqual({ tab: 'organizations' });
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.Organizations);
  });

  it('only marks the shell root as the admin surface', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });

    await renderAt('/admin');
    fireEvent.click(await screen.findByTestId('admin-mobile-menu-btn'));

    // The phone drawer renders in place, so it is styled by the same scope.
    const surfaces = document.querySelectorAll('[data-admin-surface]');
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]).toContainElement(screen.getByTestId('admin-sidebar-close-btn'));
  });
});

describe('isAdminUserProfilePath', () => {
  it('matches only user profile paths', () => {
    expect(isAdminUserProfilePath('/admin/users/abc')).toBe(true);
    expect(isAdminUserProfilePath('/admin')).toBe(false);
    expect(isAdminUserProfilePath('/admin/users')).toBe(false);
  });
});

describe('isAdminSubscriptionDetailPath', () => {
  it('matches only subscription detail paths', () => {
    expect(isAdminSubscriptionDetailPath('/admin/subscriptions/abc')).toBe(true);
    expect(isAdminSubscriptionDetailPath('/admin/subscriptions/by-stripe/sub_1')).toBe(true);
    expect(isAdminSubscriptionDetailPath('/admin')).toBe(false);
    expect(isAdminSubscriptionDetailPath('/admin/users/abc')).toBe(false);
  });
});
