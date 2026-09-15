import dynamic from 'next/dynamic';
import { Box, Stack, CircularProgress, Typography } from '@mui/joy';
import { useLocation } from '@tanstack/react-router';
import { gray } from '@client/app/utils/themes/colors';
import SidenavFooter from './Footer';
import SideNavHeader from './Header';
import { useIsTablet } from '@client/app/hooks/useIsMobile';
import { useNotebookLayout } from '..';
import { useShallow } from 'zustand/react/shallow';

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

// Dedicated, fully surface-scoped nav for /opti - the OptiHashi premium overlay
// contributes it via b4mContributions.notebookSidenavExport, and codegen emits the
// import into premiumNotebookSidenav.generated.ts (dynamic + ssr:false, so its code
// stays out of the bundle on every other route). Core imports the GENERATED glue, never
// the premium package directly, so the open-core fork (overlay absent -> null) still
// builds. Replaces CombinedNotebooks on the opti surface so the nav no longer intermixes
// default-surface sessions, projects, and agents.
import { premiumNotebookSidenav as OptiSidenav } from '@client/app/premium-generated/premiumNotebookSidenav.generated';

const NotebookSideNav = () => {
  // Tablet + mobile: slide off-screen when closed and show a dismiss backdrop
  // when open (overlay behavior). Desktop pins the sidebar in flow.
  const isTablet = useIsTablet();
  const [openSideNav, setOpenSideNav] = useNotebookLayout(useShallow(s => [s.openSideNav, s.setOpenSideNav]));
  // /opti owns a dedicated, surface-scoped nav; every other route uses the shared one.
  const isOpti = useLocation({ select: l => l.pathname === '/opti' });

  return (
    <Stack
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
          scroll region (OptiSidenav's conversation list) stays bounded and scrolls in place —
          without it, on short viewports the content overflows the sidebar and pushes the list
          (and footer) off-screen instead of scrolling. */}
      <Stack flexGrow={1} sx={{ minHeight: 0 }}>
        {isOpti && OptiSidenav ? <OptiSidenav /> : <CombinedNotebooks />}
      </Stack>

      <SidenavFooter />
    </Stack>
  );
};

export default NotebookSideNav;
