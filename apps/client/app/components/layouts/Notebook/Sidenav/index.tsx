import dynamic from 'next/dynamic';
import { Box, Stack, CircularProgress, Typography } from '@mui/joy';
import { useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { gray } from '@client/app/utils/themes/colors';
import SidenavFooter from './Footer';
import SideNavHeader from './Header';
import { useIsTablet } from '@client/app/hooks/useIsMobile';
import { useNotebookLayout } from '..';
import { useShallow } from 'zustand/react/shallow';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { getWorkspaceSurface } from '@bike4mind/common';
import { hostedWorkspaceAt } from '@client/app/utils/premiumHostedWorkspace';

// Lazy load CombinedNotebooks to reduce initial bundle size
const CombinedNotebooks = dynamic(() => import('./CombinedNotebooks'), {
  ssr: false,
  loading: () => (
    <Box
      data-testid="sidenav-notebooks-loading"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        gap: 2,
      }}
    >
      <CircularProgress aria-label="Loading notebooks" data-testid="sidenav-notebooks-loading-spinner" />
      <Typography level="body-md" sx={{ color: 'text.tertiary' }} data-testid="sidenav-notebooks-loading-message">
        Loading notebooks...
      </Typography>
    </Box>
  ),
});

// Dedicated, fully surface-scoped navs contributed by premium overlays (a workspace's own
// conversation list). An overlay declares b4mContributions.notebookSidenavExport as
// { path, exportFrom }, and codegen emits one entry per overlay into
// premiumNotebookSidenavs.generated.ts (each dynamic + ssr:false, so an overlay's code stays out
// of the bundle on every other route). Core imports the GENERATED glue, never the premium package
// directly, so the open-core fork (no overlays -> empty array) still builds. Where one applies it
// REPLACES CombinedNotebooks, so the nav there does not intermix default-surface sessions,
// projects, and agents with that surface's own list.
//
// The route is matched against `path` from the manifest, not a pathname this file names: which
// route a premium nav owns is the overlay's knowledge. That is what lets a SECOND overlay have one
// at all - the slot used to be a single component core matched against a hardcoded pathname, so
// any other overlay's nav was dropped with a codegen warning.
import { premiumNotebookSidenavs } from '@client/app/premium-generated/premiumNotebookSidenavs.generated';

const NotebookSideNav = () => {
  const { t } = useTranslation();
  // Tablet + mobile: slide off-screen when closed and show a dismiss backdrop
  // when open (overlay behavior). Desktop pins the sidebar in flow.
  const isTablet = useIsTablet();
  const [openSideNav, setOpenSideNav] = useNotebookLayout(useShallow(s => [s.openSideNav, s.setOpenSideNav]));
  // A route an overlay claims owns its dedicated, surface-scoped nav; every other route uses the
  // shared one. A claim is the route itself, or - for a workspace core registers - any app-shell
  // route declaring it hosts that workspace (see hostedWorkspaceAt), so the overlay's own nav
  // follows its workspace wherever it is hosted. First match wins (codegen warns on a duplicate
  // path).
  const pathname = useLocation({ select: l => l.pathname });
  const hostedWorkspace = hostedWorkspaceAt(pathname, premiumRoutes);
  const hostedPrefix = hostedWorkspace ? getWorkspaceSurface(hostedWorkspace)?.routePrefix : undefined;
  const PremiumSidenav = premiumNotebookSidenavs.find(
    nav => nav.path === pathname || nav.path === hostedPrefix
  )?.component;

  return (
    <Stack
      component="nav"
      aria-label={t('sidenav.sidebar', 'Sidebar')}
      data-testid="sidenav-container"
      sx={theme => ({
        height: '100dvh',
        backgroundColor: theme.palette.background.surface2,
        borderRight: `1px solid ${theme.palette.mode === 'dark' ? gray[800] : gray[200]}`,
        gap: 0,
        position: 'fixed',
        left: 0,
        top: 0,
        width: 'var(--notebook-sidenav-width)',
        transform: isTablet
          ? openSideNav
            ? 'translateX(0)'
            : 'translateX(calc(-1 * var(--notebook-sidenav-width)))'
          : 'translateX(0)',
        transition: 'transform 0.3s ease-in-out',
        zIndex: 'var(--joy-zIndex-drawer, 1200)',
      })}
    >
      {isTablet && (
        <Box
          className="sidenav-overlay"
          onClick={() => setOpenSideNav(false)}
          sx={{
            position: 'fixed',
            zIndex: 'var(--joy-zIndex-drawer, 1200)',
            top: 0,
            left: 'var(--notebook-sidenav-width)',
            width: 'calc(100vw - var(--notebook-sidenav-width))',
            height: '100dvh',
            backgroundColor: 'rgba(14, 18, 20, 0.4)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            opacity: openSideNav ? 1 : 0,
            transition: 'opacity 0.3s ease-in-out',
          }}
        />
      )}

      <SideNavHeader />

      {/* minHeight:0 lets this flex child shrink below its content height so the nav's inner
          scroll region (a premium nav's own conversation list) stays bounded and scrolls in place -
          without it, on short viewports the content overflows the sidebar and pushes the list
          (and footer) off-screen instead of scrolling. */}
      <Stack flexGrow={1} sx={{ minHeight: 0 }}>
        {PremiumSidenav ? <PremiumSidenav /> : <CombinedNotebooks />}
      </Stack>

      <SidenavFooter />
    </Stack>
  );
};

export default NotebookSideNav;
