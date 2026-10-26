import { Suspense, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import CloseIcon from '@mui/icons-material/Close';
import HelpCenterIcon from '@mui/icons-material/HelpCenter';
import MenuIcon from '@mui/icons-material/Menu';
import { Box, Drawer, IconButton, Sheet, Tooltip, Typography } from '@mui/joy';
import RestrictedPage from '@client/app/components/common/RestrictedPage';
import { ProviderBundle } from '@client/app/contexts/ProviderBundle';
import { useUser } from '@client/app/contexts/UserContext';
import { useLiveOpsTriageEnv } from '@client/app/hooks/data/admin';
import { useGetWaitingSubscribersCount } from '@client/app/hooks/data/subscribers';
import { useHelpKeyboardShortcut } from '@client/app/hooks/useHelpKeyboardShortcut';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import { HelpPanel } from '../help';
import { SidebarNav } from './AdminSidebarNav';
import { AdminTab } from './adminSidebarConfig';
import { adminTabToSlug } from './adminTabSlugs';
import { adminFocus } from './shared/adminStyles';
import { resolveEnvironmentBanner } from './environmentBanner';
import { useAdminModal } from './useAdminModal';
import { useAdminNotifications } from './useAdminNotifications';
import { useAdminSidebarCollapsed } from './useAdminSidebarSections';

const ADMIN_CONSOLE_PATH = '/admin';

/** A user profile page belongs to the Users tab, so the sidebar highlights Users there. */
export const isAdminUserProfilePath = (pathname: string) => pathname.startsWith('/admin/users/');

const EnvironmentBanner = () => {
  const router = useRouter();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  const { bannerColor, environmentName } = resolveEnvironmentBanner(hostname, process.env.NEXT_PUBLIC_SERVER_DOMAIN);

  const bannerButtonSx = {
    color: 'white',
    padding: '4px',
    '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.2)' },
    ...adminFocus,
  };

  return (
    <Box
      sx={{
        backgroundColor: bannerColor,
        color: 'white',
        padding: '4px 8px',
        textAlign: 'center',
        fontWeight: 'bold',
        flexShrink: 0,
        zIndex: 1100,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        height: '32px',
        boxSizing: 'border-box',
      }}
    >
      <Box flexBasis="40px" />
      <Typography level="body-sm" sx={{ color: 'white', flexGrow: 1, textAlign: 'center' }}>
        {environmentName}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Tooltip title="Help Center (Shift+?)" placement="bottom">
          <IconButton
            onClick={() => openHelpPanel()}
            sx={bannerButtonSx}
            size="sm"
            aria-label="Open Help Center"
            data-testid="admin-help-center-btn"
          >
            <HelpCenterIcon fontSize="small" sx={{ color: 'white' }} />
          </IconButton>
        </Tooltip>
        <IconButton onClick={() => router.history.back()} sx={bannerButtonSx} size="sm" aria-label="Leave admin">
          <CloseIcon fontSize="small" sx={{ color: 'white' }} data-testid="close-admin-page-banner-btn" />
        </IconButton>
      </Box>
    </Box>
  );
};

type AdminLayoutProps = {
  children: ReactNode;
  /** Must match the flag `routes/admin/index.tsx` passes to AdminPage, which gates the same tab. */
  enableUserMigration?: boolean;
};

/**
 * The admin shell every admin page renders inside: environment banner, sidebar (an icon rail
 * when collapsed on desktop, a drawer on phones) and the scrolling content frame.
 *
 * `data-admin-surface` on the root is the contract with the admin skin: it scopes the admin
 * theme to everything under it, so this must stay the only element carrying it. The phone
 * drawer is rendered in place (not portalled) to stay inside that scope.
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
  const { collapsed, toggleCollapsed } = useAdminSidebarCollapsed();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useHelpKeyboardShortcut();

  const activeTab = isAdminUserProfilePath(pathname) ? AdminTab.Users : storedActiveTab;

  const selectTab = (tab: AdminTab) => {
    setDrawerOpen(false);
    setActiveTab(tab);
    // On the console the tab URL sync mirrors the store into `?tab=`; anywhere else, go there.
    if (pathname === ADMIN_CONSOLE_PATH) return;
    navigate({ to: '/admin', search: { tab: adminTabToSlug(tab) } });
  };

  const navProps = {
    activeTab,
    enableUserMigration,
    showLiveOpsTriageTab: liveOpsEnv?.showTab ?? false,
    waitingSubscribersCount: waitingSubscribers.data?.count,
    hiddenNotifications,
    onTabSelect: selectTab,
  };

  return (
    <Sheet
      data-admin-surface=""
      data-testid="admin-layout"
      sx={theme => ({
        height: '100dvh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'admin.canvas',
        '& ::-webkit-scrollbar': { width: '6px', height: '6px' },
        '& ::-webkit-scrollbar-track': { background: 'transparent' },
        '& ::-webkit-scrollbar-thumb': {
          background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
          borderRadius: '4px',
        },
        '& ::-webkit-scrollbar-thumb:hover': {
          background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
        },
      })}
    >
      <EnvironmentBanner />
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
          <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
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
        <SidebarNav {...navProps} onClose={() => setDrawerOpen(false)} />
      </Drawer>
      <HelpPanel />
    </Sheet>
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
