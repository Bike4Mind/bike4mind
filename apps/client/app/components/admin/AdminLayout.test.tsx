import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import {
  AdminLayoutRoute,
  isAdminModelsDetailPath,
  isAdminSubscriptionDetailPath,
  isAdminUserProfilePath,
} from './AdminLayout';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';

const mockUseUser = vi.fn();
const profileRendered = vi.fn();
const modelRendered = vi.fn();

vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => mockUseUser() }));
vi.mock('@client/app/utils/user', () => ({ userIsDeveloper: () => false }));
vi.mock('@client/app/hooks/data/entitlements', () => ({
  useEntitlements: () => ({ data: undefined, isSuccess: false, isError: false }),
}));
vi.mock('@client/app/contexts/ProviderBundle', () => ({
  ProviderBundle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@client/app/hooks/data/admin', () => ({ useLiveOpsTriageEnv: () => ({ data: { showTab: false } }) }));
const mockActionCounts = vi.hoisted(() =>
  vi.fn((_opts: { enabled: boolean }): { data: Record<string, number> | undefined } => ({ data: undefined }))
);
vi.mock('@client/app/hooks/data/adminActionCounts', () => ({
  adminActionCountsQueryKey: ['admin', 'action-counts'],
  useAdminActionCounts: mockActionCounts,
}));
vi.mock('./Subscriptions/subscriptionsLastSeen', () => ({ useNewSubscriptionsDot: () => false }));
vi.mock('@client/app/hooks/useHelpKeyboardShortcut', () => ({ useHelpKeyboardShortcut: () => undefined }));
vi.mock('../help', () => ({ HelpPanel: () => null }));

const theme = extendTheme({ ...getThemeConfig() });

let queryClient = new QueryClient();

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
    component: () => {
      profileRendered();
      return <div data-testid="profile-page">profile</div>;
    },
  });
  const modelRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: '/admin/models/$',
    component: () => {
      modelRendered();
      return <div data-testid="model-page">model</div>;
    },
  });
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/new',
    component: () => <div data-testid="new-page">new</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([layoutRoute.addChildren([consoleRoute, profileRoute, modelRoute]), newRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={theme}>
          <RouterProvider router={router} />
        </CssVarsProvider>
      </QueryClientProvider>
    );
  });
  return router;
};

const desktopSidebar = () => screen.getAllByTestId('admin-sidebar-nav')[0];

describe('AdminLayoutRoute', () => {
  beforeEach(() => {
    queryClient = new QueryClient();
    mockActionCounts.mockImplementation(() => ({ data: undefined }));
    window.localStorage.clear();
    useAdminModal.setState({ activeTab: AdminTab.Dashboard });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useAccessToken.setState({ impersonating: false });
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

  describe('a delegated admin', () => {
    const delegate = (adminPermissions: string[]) => ({
      currentUser: { id: 'u1', name: 'Dee', isAdmin: false, adminPermissions, tags: [] },
    });

    it('with settings:manage enters the console and sees only the tabs they may open', async () => {
      mockUseUser.mockReturnValue(delegate(['settings:manage']));

      await renderAt('/admin');

      const layout = await screen.findByTestId('admin-layout');
      expect(within(layout).getByTestId('console-page')).toBeInTheDocument();
      const sidebar = desktopSidebar();
      expect(within(sidebar).getByTestId('admin-modals-tab-btn')).toBeInTheDocument();
      expect(within(sidebar).queryByTestId('admin-users-tab-btn')).toBeNull();
      expect(within(sidebar).queryByTestId('admin-dashboard-tab-btn')).toBeNull();
      expect(within(sidebar).getByText('Delegated admin')).toBeInTheDocument();
    });

    it('with support:read enters the console and sees the support tabs', async () => {
      mockUseUser.mockReturnValue(delegate(['support:read']));

      await renderAt('/admin');

      await screen.findByTestId('admin-layout');
      const sidebar = desktopSidebar();
      expect(within(sidebar).getByTestId('admin-approvals-btn')).toBeInTheDocument();
      expect(within(sidebar).queryByTestId('admin-modals-tab-btn')).toBeNull();
      expect(within(sidebar).queryByTestId('admin-users-tab-btn')).toBeNull();
    });

    it('whose permissions open no tab is sent to /new', async () => {
      mockUseUser.mockReturnValue(delegate(['users:impersonate']));

      const router = await renderAt('/admin');

      await waitFor(() => expect(router.state.location.pathname).toBe('/new'));
      expect(screen.queryByTestId('admin-layout')).toBeNull();
    });

    it('cannot open a user profile, whose Users tab they may not open', async () => {
      mockUseUser.mockReturnValue(delegate(['settings:manage']));

      const router = await renderAt('/admin/users/0123456789abcdef01234567');

      const state = await screen.findByTestId('admin-missing-permission-state');
      expect(state).toHaveTextContent('Full admin access required');
      expect(router.state.location.pathname).toBe('/admin/users/0123456789abcdef01234567');
      // Never rendered, not just hidden: a mounted profile fires admin requests.
      expect(profileRendered).not.toHaveBeenCalled();
    });

    it('cannot open a model page without support:read, which the Models tab needs', async () => {
      mockUseUser.mockReturnValue(delegate(['settings:manage']));

      await renderAt('/admin/models/example-text-1');

      expect(await screen.findByTestId('admin-missing-permission-state')).toHaveTextContent(
        'Missing permission: support:read'
      );
      expect(modelRendered).not.toHaveBeenCalled();
    });

    it.each([['support:read'], ['support:read', 'settings:manage']])(
      'opens a model page for a delegate holding %s',
      async (...permissions) => {
        mockUseUser.mockReturnValue(delegate(permissions));

        await renderAt('/admin/models/example-text-1');

        expect(await screen.findByTestId('model-page')).toBeInTheDocument();
        expect(screen.queryByTestId('admin-missing-permission-state')).toBeNull();
        expect(within(desktopSidebar()).getByTestId('admin-models-tab-btn')).toBeInTheDocument();
      }
    );
  });

  it('keeps the sidebar on a model page, with Models active', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });

    await renderAt('/admin/models/example-text-1');

    const layout = await screen.findByTestId('admin-layout');
    expect(within(layout).getByTestId('model-page')).toBeInTheDocument();
    expect(within(desktopSidebar()).getByTestId('admin-models-tab-btn')).toHaveAttribute('aria-current', 'page');
  });

  it('renders the console inside the shell for an admin', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });

    await renderAt('/admin');

    const layout = await screen.findByTestId('admin-layout');
    expect(layout).toHaveAttribute('data-admin-surface');
    expect(within(layout).getByTestId('console-page')).toBeInTheDocument();
    expect(within(desktopSidebar()).getByTestId('admin-dashboard-tab-btn')).toHaveAttribute('aria-current', 'page');
  });

  it('does not fetch the sidebar counts for a full admin who is impersonating', async () => {
    useAccessToken.setState({ impersonating: true });
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });
    await renderAt('/admin');
    await screen.findByTestId('admin-layout');
    expect(mockActionCounts).toHaveBeenCalled();
    expect(mockActionCounts).not.toHaveBeenCalledWith({ enabled: true });
  });

  it('does not fetch the sidebar counts for a delegated admin', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', adminPermissions: ['settings:manage'], tags: [] } });
    await renderAt('/admin');
    await screen.findByTestId('admin-layout');
    expect(mockActionCounts).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('badges the sidebar from the batched counts for a full admin', async () => {
    mockActionCounts.mockImplementation(() => ({ data: { moderationReview: 4, feedback: 0 } }));
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });
    await renderAt('/admin');
    await screen.findByTestId('admin-layout');
    expect(mockActionCounts).toHaveBeenLastCalledWith({ enabled: true });
    expect(within(desktopSidebar()).getByTestId('admin-sidebar-moderationReview-badge')).toHaveTextContent('4');
    expect(within(desktopSidebar()).queryByTestId('admin-sidebar-feedback-badge')).toBeNull();
  });

  it('refreshes the sidebar counts when the admin moves to another tab', async () => {
    mockUseUser.mockReturnValue({ currentUser: { id: 'u1', isAdmin: true, tags: [] } });
    await renderAt('/admin');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    fireEvent.click(within(desktopSidebar()).getByTestId('admin-users-tab-btn'));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'action-counts'] });
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

describe('isAdminModelsDetailPath', () => {
  it('matches model detail and run pages, not the console', () => {
    expect(isAdminModelsDetailPath('/admin/models/example-text-1')).toBe(true);
    expect(isAdminModelsDetailPath('/admin/models/runs/run-1')).toBe(true);
    expect(isAdminModelsDetailPath('/admin')).toBe(false);
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
