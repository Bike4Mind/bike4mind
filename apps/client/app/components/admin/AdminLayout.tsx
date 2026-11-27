import { Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useLocation, useNavigate, useRouterState } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import MenuIcon from '@mui/icons-material/Menu';
import { Box, Drawer, IconButton, Sheet, Typography } from '@mui/joy';
import { hasAdminPermission, isFullAdmin } from '@bike4mind/common';
import RestrictedPage from '@client/app/components/common/RestrictedPage';
import { ProviderBundle } from '@client/app/contexts/ProviderBundle';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { adminActionCountsQueryKey, useAdminActionCounts } from '@client/app/hooks/data/adminActionCounts';
import { HelpPanel } from '../help';
import EnvironmentBanner from './AdminEnvironmentBanner';
import { SidebarNav } from './AdminSidebarNav';
import { useAdminPageUsage } from './Dashboard/adminPageVisits';
import { pinnedSidebarSection } from './Dashboard/dashboardNav';
import { canOpenContributedAdminPage, withContributedPages, type ContributedAdminPage } from './adminContributedPages';
import { isAdminExtPath } from './adminExtPath';
import { AdminTab, SIDEBAR_SECTIONS } from './adminSidebarConfig';
import { canEnterAdminConsole, canOpenAdminTab, DELEGATED_ADMIN_TAB_PERMISSIONS } from './adminTabPermissions';
import { environmentChipLabel, resolveCurrentEnvironment } from './environmentBanner';
import { adminTabToSlug } from './adminTabSlugs';
import { AdminCommandPalette } from './shared/AdminCommandPalette';
import { MissingPermissionState } from './shared/MissingPermission';
import { adminFocus, adminScrollGutter } from './shared/adminStyles';
import { useNewSubscriptionsDot } from './Subscriptions/subscriptionsLastSeen';
import { useAdminModal } from './useAdminModal';
import { useAdminNotifications } from './useAdminNotifications';
import { useAdminSidebarCollapsed } from './useAdminSidebarState';

const ADMIN_CONSOLE_PATH = '/admin';

/** A user profile page belongs to the Users tab, so the sidebar highlights Users there. */
export const isAdminUserProfilePath = (pathname: string) => pathname.startsWith('/admin/users/');

/** Subscription detail pages (including the by-stripe resolver) belong to the Subscriptions tab. */
export const isAdminSubscriptionDetailPath = (pathname: string) => pathname.startsWith('/admin/subscriptions/');

/** Model detail and discovery run pages belong to the Models tab. */
export const isAdminModelsDetailPath = (pathname: string) => pathname.startsWith('/admin/models/');

const isAdminQaPath = (pathname: string) => pathname === '/admin/qa' || pathname.startsWith('/admin/qa/');

/** The tab a detail page belongs to, or undefined off a detail page. */
const detailPageTabFor = (pathname: string): AdminTab | undefined =>
  isAdminUserProfilePath(pathname)
    ? AdminTab.Users
    : isAdminSubscriptionDetailPath(pathname)
      ? AdminTab.Subscriptions
      : isAdminModelsDetailPath(pathname)
        ? AdminTab.Models
        : undefined;

const NO_ADMIN_PAGES: readonly ContributedAdminPage[] = [];

type AdminLayoutProps = {
  children: ReactNode;
  /** Must match the flag `routes/admin/index.tsx` passes to AdminPage, which gates the same tab. */
  enableUserMigration?: boolean;
  /** Pages a premium package contributes; each is listed in the sidebar for full admins. */
  adminPages?: readonly ContributedAdminPage[];
};

/**
 * The admin shell every admin page renders inside: environment banner, sidebar (an icon rail
 * when collapsed on desktop, a drawer on phones) and the scrolling content frame.
 *
 * `data-admin-surface` on the shell sheet is the contract with the admin skin: it scopes the
 * admin theme to everything under it, so this must stay the only element carrying it. The
 * environment banner sits above it, outside the skin (see AdminEnvironmentBanner); app-wide chrome
 * rendered inside it (the AI chat, the help panel) opts out with `data-admin-surface-exclude`. The
 * phone drawer is rendered in place (not portalled) to stay inside the scope.
 */
export const AdminLayout = ({
  children,
  enableUserMigration = false,
  adminPages = NO_ADMIN_PAGES,
}: AdminLayoutProps) => {
  const pathname = useLocation({ select: location => location.pathname });
  const navigate = useNavigate();
  const [storedActiveTab, setActiveTab] = useAdminModal(useShallow(state => [state.activeTab, state.setActiveTab]));
  const hiddenNotifications = useAdminNotifications(state => state.hiddenNotifications);
  const { currentUser } = useUser();
  const isAdmin = !!currentUser?.isAdmin;
  const impersonating = useAccessToken(s => s.impersonating);
  // The route needs support:read and gates each count by its own permission, so a delegate sees only the held grants count.
  const actionCounts = useAdminActionCounts({
    enabled: (isFullAdmin(currentUser) || hasAdminPermission(currentUser, 'support:read')) && !impersonating,
  });
  const queryClient = useQueryClient();
  const newSubscriptions = useNewSubscriptionsDot(isAdmin);
  const { collapsed, toggleCollapsed } = useAdminSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const detailPageTab = detailPageTabFor(pathname);
  // A contributed page and the QA pages are no tab, so none is highlighted while one is open.
  const onContributedPage = isAdminExtPath(pathname);
  const activeTab = onContributedPage || isAdminQaPath(pathname) ? null : (detailPageTab ?? storedActiveTab);
  const canOpenPage = useCallback(() => canOpenContributedAdminPage(currentUser), [currentUser]);

  // A detail page belongs to its tab, so a delegate who cannot open that tab cannot open the page.
  const canOpenTab = useCallback((tab: AdminTab) => canOpenAdminTab(currentUser, tab), [currentUser]);
  const pins = useAdminPageUsage(currentUser?.id).pins;
  const sections = useMemo(() => {
    const pinned = pinnedSidebarSection(pins, canOpenTab);
    const withPages = withContributedPages(SIDEBAR_SECTIONS, adminPages);
    return pinned ? [pinned, ...withPages] : withPages;
  }, [adminPages, pins, canOpenTab]);
  const deniedTabOf = (path: string) => {
    const tab = detailPageTabFor(path);
    return tab !== undefined && !canOpenTab(tab) ? tab : undefined;
  };
  // The outlet draws the matched route, which trails the location during a navigation, so check
  // both: one render of a denied page would already fire its requests.
  const renderedPathname = useRouterState({ select: state => state.matches.at(-1)?.pathname ?? '' });
  const deniedDetailTab = deniedTabOf(pathname) ?? deniedTabOf(renderedPathname);
  // Same rule for a contributed page, which no delegated permission opens.
  const deniedContributedPage =
    !canOpenContributedAdminPage(currentUser) && (isAdminExtPath(pathname) || isAdminExtPath(renderedPathname));

  const selectTab = (tab: AdminTab) => {
    setDrawerOpen(false);
    // Work done on the page being left shows in its badge now rather than at the next poll.
    void queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey });
    setActiveTab(tab);
    // On the console the tab URL sync mirrors the store into `?tab=`; anywhere else, go there.
    if (pathname === ADMIN_CONSOLE_PATH) return;
    navigate({ to: '/admin', search: { tab: adminTabToSlug(tab) } });
  };

  const selectPage = (path: string) => {
    setDrawerOpen(false);
    void queryClient.invalidateQueries({ queryKey: adminActionCountsQueryKey });
    navigate({ href: path });
  };

  const account = currentUser
    ? {
        name: currentUser.name || currentUser.username || currentUser.email || 'Admin',
        role: isAdmin ? 'Admin' : 'Delegated admin',
        photoUrl: currentUser.photoUrl ?? undefined,
      }
    : undefined;

  const navProps = {
    activeTab,
    account,
    enableUserMigration,
    actionCounts: actionCounts.data,
    // No dot on the tab the admin is looking at; a row started meanwhile lights it once they leave.
    newSubscriptions: newSubscriptions && activeTab !== AdminTab.Subscriptions,
    isFullAdmin: isFullAdmin(currentUser),
    hiddenNotifications,
    canOpenTab,
    onTabSelect: selectTab,
    sections,
    canOpenPage,
    activePagePath: onContributedPage ? pathname : null,
    onPageSelect: selectPage,
    environmentLabel: environmentChipLabel[resolveCurrentEnvironment().environment],
  };

  return (
    <Box sx={{ height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <EnvironmentBanner />
      <Sheet
        data-admin-surface=""
        data-testid="admin-layout"
        sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: 'admin.canvas' }}
      >
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <Box sx={{ display: { xs: 'none', md: 'flex' }, flexShrink: 0 }}>
            <SidebarNav {...navProps} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
          </Box>
          <Box
            component="main"
            data-testid="admin-layout-content"
            sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
          >
            {(isAdminSubscriptionDetailPath(pathname) || isAdminModelsDetailPath(pathname) || onContributedPage) && (
              <AdminCommandPalette enableEntitySearch={isAdmin} canOpenTab={canOpenTab} onNavigate={selectTab} />
            )}
            <Box
              sx={{
                display: { xs: 'flex', md: 'none' },
                alignItems: 'center',
                gap: 1,
                px: 1,
                py: 0.75,
                flexShrink: 0,
                borderBottom: '1px solid',
                borderColor: 'admin.border',
                bgcolor: 'admin.canvas',
              }}
            >
              <IconButton
                onClick={() => setDrawerOpen(true)}
                size="sm"
                variant="plain"
                color="neutral"
                data-testid="admin-mobile-menu-btn"
                aria-label="Open admin menu"
                aria-expanded={drawerOpen}
                sx={adminFocus}
              >
                <MenuIcon />
              </IconButton>
              <Typography level="title-sm" sx={{ color: 'admin.ink' }}>
                Admin
              </Typography>
            </Box>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', ...adminScrollGutter }}>
              {deniedDetailTab !== undefined ? (
                <MissingPermissionState requirement={DELEGATED_ADMIN_TAB_PERMISSIONS[deniedDetailTab]} />
              ) : deniedContributedPage ? (
                <MissingPermissionState />
              ) : (
                children
              )}
            </Box>
          </Box>
        </Box>
        <Drawer
          anchor="left"
          size="sm"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          disablePortal
          slotProps={{ content: { sx: { width: 280, bgcolor: 'admin.canvas' } } }}
        >
          {/* Only while open: a hidden second nav would duplicate every sidebar testid on desktop. */}
          {drawerOpen && <SidebarNav {...navProps} onClose={() => setDrawerOpen(false)} />}
        </Drawer>
        <HelpPanel />
      </Sheet>
    </Box>
  );
};

/**
 * The `/admin` layout route's element. The guard, the providers and the Suspense boundary live
 * here once, so no admin child route can render outside them or without the sidebar.
 */
export const AdminLayoutRoute = ({
  fallback,
  adminPages,
}: {
  fallback: ReactNode;
  adminPages?: readonly ContributedAdminPage[];
}) => (
  <RestrictedPage requireAccess={canEnterAdminConsole}>
    {/* Mounted only behind the guard, so an unauthorised visit does not trigger their fetches. */}
    <ProviderBundle>
      <AdminLayout adminPages={adminPages}>
        <Suspense fallback={fallback}>
          <Outlet />
        </Suspense>
      </AdminLayout>
    </ProviderBundle>
  </RestrictedPage>
);
