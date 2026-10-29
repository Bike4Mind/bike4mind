import { Suspense, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import MenuIcon from '@mui/icons-material/Menu';
import { Box, Drawer, IconButton, Sheet, Typography } from '@mui/joy';
import RestrictedPage from '@client/app/components/common/RestrictedPage';
import { ProviderBundle } from '@client/app/contexts/ProviderBundle';
import { useUser } from '@client/app/contexts/UserContext';
import { useLiveOpsTriageEnv } from '@client/app/hooks/data/admin';
import { useGetWaitingSubscribersCount } from '@client/app/hooks/data/subscribers';
import { HelpPanel } from '../help';
import EnvironmentBanner from './AdminEnvironmentBanner';
import { SidebarNav } from './AdminSidebarNav';
import { AdminTab } from './adminSidebarConfig';
import { environmentChipLabel, resolveCurrentEnvironment } from './environmentBanner';
import { adminTabToSlug } from './adminTabSlugs';
import { adminFocus, adminScrollGutter } from './shared/adminStyles';
import { useNewSubscriptionsDot } from './Subscriptions/subscriptionsLastSeen';
import { useAdminModal } from './useAdminModal';
import { useAdminNotifications } from './useAdminNotifications';
import { useAdminSidebarCollapsed } from './useAdminSidebarState';

const ADMIN_CONSOLE_PATH = '/admin';

/** A user profile page belongs to the Users tab, so the sidebar highlights Users there. */
export const isAdminUserProfilePath = (pathname: string) => pathname.startsWith('/admin/users/');

type AdminLayoutProps = {
  children: ReactNode;
  /** Must match the flag `routes/admin/index.tsx` passes to AdminPage, which gates the same tab. */
  enableUserMigration?: boolean;
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
export const AdminLayout = ({ children, enableUserMigration = false }: AdminLayoutProps) => {
  const pathname = useLocation({ select: location => location.pathname });
  const navigate = useNavigate();
  const [storedActiveTab, setActiveTab] = useAdminModal(useShallow(state => [state.activeTab, state.setActiveTab]));
  const hiddenNotifications = useAdminNotifications(state => state.hiddenNotifications);
  const { currentUser } = useUser();
  const isAdmin = !!currentUser?.isAdmin;
  const { data: liveOpsEnv } = useLiveOpsTriageEnv(isAdmin);
  const waitingSubscribers = useGetWaitingSubscribersCount({ enabled: isAdmin });
  const newSubscriptions = useNewSubscriptionsDot(isAdmin);
  const { collapsed, toggleCollapsed } = useAdminSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeTab = isAdminUserProfilePath(pathname) ? AdminTab.Users : storedActiveTab;

  const selectTab = (tab: AdminTab) => {
    setDrawerOpen(false);
    setActiveTab(tab);
    // On the console the tab URL sync mirrors the store into `?tab=`; anywhere else, go there.
    if (pathname === ADMIN_CONSOLE_PATH) return;
    navigate({ to: '/admin', search: { tab: adminTabToSlug(tab) } });
  };

  const account = currentUser
    ? {
        name: currentUser.name || currentUser.username || currentUser.email || 'Admin',
        role: 'Admin',
        photoUrl: currentUser.photoUrl ?? undefined,
      }
    : undefined;

  const navProps = {
    activeTab,
    account,
    enableUserMigration,
    showLiveOpsTriageTab: liveOpsEnv?.showTab ?? false,
    waitingSubscribersCount: waitingSubscribers.data?.count,
    // No dot on the tab the admin is looking at; a row started meanwhile lights it once they leave.
    newSubscriptions: newSubscriptions && activeTab !== AdminTab.Subscriptions,
    hiddenNotifications,
    onTabSelect: selectTab,
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
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', ...adminScrollGutter }}>{children}</Box>
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
export const AdminLayoutRoute = ({ fallback }: { fallback: ReactNode }) => (
  <RestrictedPage requireAdmin>
    {/* Mounted only behind the guard, so an unauthorised visit does not trigger their fetches. */}
    <ProviderBundle>
      <AdminLayout>
        <Suspense fallback={fallback}>
          <Outlet />
        </Suspense>
      </AdminLayout>
    </ProviderBundle>
  </RestrictedPage>
);
