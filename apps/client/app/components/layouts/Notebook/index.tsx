import Grid from '@mui/joy/Grid';
import { FC, PropsWithChildren, ReactNode, useEffect, useRef, useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import NotebookSideNav from './Sidenav';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { Box, Drawer, Typography } from '@mui/joy';
import CollapseButton from '../../Session/CollapseButton';
import { useMediaQuery } from '@mui/system';
import { useTheme as useJoyTheme } from '@mui/joy';
import KnowledgeModal from '../../Knowledge/KnowledgeModal';
import { HelpPanel, HelpSuggestionBanner } from '../../help';
import DataLakeUploadIndicator from '../../DataLakeWizard/DataLakeUploadIndicator';
import { useHelpKeyboardShortcut } from '@client/app/hooks/useHelpKeyboardShortcut';
import { useCommandPaletteShortcut } from '@client/app/hooks/useCommandPaletteShortcut';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { keyframes } from '@mui/system';
import NotebookHeader from './Header';
import { gray } from '@client/app/utils/themes/colors';
import useDataLakeMode from '@client/app/hooks/useDataLakeMode';
import type { NotebookContentFilter, NotebookOriginFilter } from './Sidenav/sidenavFilters';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { edgeToEdgePaths, isEdgeToEdgePath } from '@client/app/utils/premiumEdgeToEdge';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { routeHeading } from './routeHeading';

// Empty in the open-core build, where premiumRoutes is empty.
const EDGE_TO_EDGE_PATHS = edgeToEdgePaths(premiumRoutes);

export interface NotebookLayoutProps {
  children: ReactNode;
}

interface NotebookLayoutState {
  openSideNav: boolean;
  setOpenSideNav: (val: boolean) => void;
  showMessageCounts: boolean;
  setShowMessageCounts: (val: boolean) => void;
  /** Sidebar Content / Origin filters (see Sidenav/sidenavFilters.ts); persisted like showMessageCounts. */
  contentFilter: NotebookContentFilter;
  setContentFilter: (val: NotebookContentFilter) => void;
  originFilter: NotebookOriginFilter;
  setOriginFilter: (val: NotebookOriginFilter) => void;
}

export const useNotebookLayout = create<NotebookLayoutState>()(
  persist(
    set => ({
      openSideNav: true,
      setOpenSideNav: (val: boolean) => set({ openSideNav: val }),
      showMessageCounts: false,
      setShowMessageCounts: (val: boolean) => set({ showMessageCounts: val }),
      contentFilter: 'all',
      setContentFilter: (val: NotebookContentFilter) => set({ contentFilter: val }),
      originFilter: 'all',
      setOriginFilter: (val: NotebookOriginFilter) => set({ originFilter: val }),
    }),
    {
      name: 'notebook-layout',
      // On mobile, the sidenav is a full-screen drawer that hides the chat input.
      // Always start collapsed so the user lands on the chat composer; the hamburger
      // menu reopens it. Desktop behavior is unchanged - the persisted value wins.
      onRehydrateStorage: () => state => {
        if (state && typeof window !== 'undefined' && window.matchMedia('(max-width: 599.95px)').matches) {
          state.openSideNav = false;
        }
      },
    }
  )
);

const pulseBorder = keyframes`
  0% {
    border-color: rgba(211, 47, 47, 0.5);
  }
  50% {
    border-color: rgba(211, 47, 47, 1);
  }
  100% {
    border-color: rgba(211, 47, 47, 0.5);
  }
`;

const NotebookLayout: FC<PropsWithChildren<NotebookLayoutProps>> = ({ children }) => {
  const openSideNav = useNotebookLayout(s => s.openSideNav);
  const isMobile = useIsMobile();
  const isImpersonating = useAccessToken(s => s.impersonating);

  // Global keyboard shortcuts
  useHelpKeyboardShortcut();
  useCommandPaletteShortcut();

  // Mirrors useOptiAccess's route check: '/opti' only exists in overlay builds.
  const { pathname } = useLocation();
  const isOptiRoute = pathname.startsWith('/opti');
  const dataLakeModeOn = useDataLakeMode(s => s.enabled);
  const heading = routeHeading(pathname);
  const mainRef = useRef<HTMLDivElement>(null);

  // A route change that unmounts the focused control (an account menu item, a dialog's opener)
  // drops focus to <body>, sending keyboard and screen reader users back to the top of the page.
  // Land them on the new screen's heading instead; a screen that focuses its own control wins.
  // Skipped on first load: focusing main there would start keyboard users past the sidebar.
  const lastPathnameRef = useRef(pathname);
  useEffect(() => {
    if (lastPathnameRef.current === pathname) return;
    lastPathnameRef.current = pathname;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const target = mainRef.current?.querySelector<HTMLElement>('h1') ?? mainRef.current;
      if (!target) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  // Opti hub / in-chat Data Lake mode / edgeToEdge premium routes own their edge-to-edge layout;
  // the notebook gutter would double up as a visible frame around them. The 36px left is
  // clearance for the collapsed sidenav's floating expand control, not a gutter.
  const getContentPadding = (): string => {
    if (isMobile || isOptiRoute || isEdgeToEdgePath(pathname, EDGE_TO_EDGE_PATHS) || dataLakeModeOn) return '0px';
    return openSideNav ? '8px' : '8px 8px 8px 36px';
  };

  return (
    <Grid
      className="notebook-layout-container"
      container
      sx={{
        width: '100%',
        height: '100dvh',
        overflow: 'hidden',
        border: isImpersonating ? '3px solid #d32f2f' : 'none',
        animation: isImpersonating ? `${pulseBorder} 2s infinite` : 'none',
      }}
    >
      {/* Header */}
      <NotebookHeader />

      {/* SideNav */}
      <SideNavWrapper>
        <NotebookSideNav />
      </SideNavWrapper>

      {/* Main: a sibling of the header and sidebar nav landmarks, never their parent */}
      <Grid
        ref={mainRef}
        component="main"
        id="main-content"
        tabIndex={-1}
        className="notebook-layout-main"
        sx={{
          position: 'relative',
          '&:focus, & h1:focus': { outline: 'none' },
        }}
        lg
        md
        sm
        xs
      >
        <Grid
          className="notebook-layout-content-container"
          container
          sx={{
            width: '100%',
            height: '100dvh',
            position: 'relative',
            paddingTop: { xs: 'var(--notebook-header-height)', sm: 0 },
          }}
        >
          <Grid
            className="notebook-layout-content"
            xs={12}
            sx={{
              width: '100%',
              height: '100%',
              p: getContentPadding(),
            }}
          >
            {heading && (
              <Typography level="h1" sx={visuallyHidden} data-testid="route-heading">
                {heading}
              </Typography>
            )}
            {children}
          </Grid>
        </Grid>
      </Grid>
      <KnowledgeModal />
      <HelpPanel />
      <HelpSuggestionBanner />
      <DataLakeUploadIndicator />
    </Grid>
  );
};

const SideNavWrapper: FC<{ children: ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false);
  const [openSideNav, setOpenSideNav] = useNotebookLayout(useShallow(s => [s.openSideNav, s.setOpenSideNav]));
  const joyTheme = useJoyTheme();
  const isMobile = useMediaQuery(joyTheme.breakpoints.down('sm'));
  // Below `md` (tablet + mobile) the sidebar overlays content instead of
  // pushing it; the closed-state edge trigger/drawer stays gated on `isMobile`
  // so tablet keeps a way to reopen.
  const isTablet = useMediaQuery(joyTheme.breakpoints.down('md'));

  // Sync with openSideNav
  useEffect(() => {
    setOpen(openSideNav);
  }, [openSideNav]);

  // Handle click on trigger to pin sidenav
  const handleTriggerClick = () => {
    setOpenSideNav(true);
  };

  // Handle click outside to close sidenav (temporary)
  const handleBackdropClick = () => {
    setOpen(false);
  };

  return (
    <>
      {openSideNav ? (
        <Grid
          className="NotebookSideNav"
          sx={theme => ({
            transition: 'width 0.3s ease-in-out',
            width: 'var(--notebook-sidenav-width)',
            position: isTablet ? 'fixed' : 'relative',
            ...(open &&
              isTablet && {
                top: 0,
                left: 0,
                height: '100dvh',
                zIndex: 'var(--joy-zIndex-drawer, 1200)',
              }),
          })}
          xs={openSideNav ? 12 : 0}
        >
          {children}
        </Grid>
      ) : (
        <>
          {!isMobile && (
            <>
              {/* Trigger button on the left edge */}
              {!open && (
                <Box
                  className="sidenav-trigger"
                  onClick={handleTriggerClick}
                  sx={theme => ({
                    position: 'fixed',
                    left: 0,
                    top: 0,
                    width: '24px',
                    height: '100dvh',
                    cursor: 'pointer',
                    zIndex: 500,
                    borderRight: `1px solid ${theme.palette.mode === 'dark' ? gray[800] : gray[200]}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.3s ease',
                    backgroundColor: theme.palette.background.surface2,
                    '&:hover': {
                      transition: 'all 0.2s ease-in-out',
                      backgroundColor: theme.palette.notebooklist.hoverBg,
                      '& .collapse-button-indicator': {
                        transform: 'translateX(2px)',
                      },
                    },
                  })}
                >
                  {!openSideNav && (
                    <CollapseButton isOpenedSideNav={openSideNav} onClick={() => setOpenSideNav(!openSideNav)} />
                  )}
                </Box>
              )}
              <Drawer
                className="notebook-layout-drawer"
                slotProps={{
                  root: {
                    sx: {
                      zIndex: 600,
                    },
                  },
                  content: {
                    sx: {
                      width: 'var(--notebook-sidenav-width)',
                    },
                  },
                  backdrop: {
                    sx: {
                      display: open ? 'block' : 'none',
                      backgroundColor: 'transparent',
                    },
                    onClick: handleBackdropClick,
                  },
                }}
                open={open}
              >
                {children}
              </Drawer>
            </>
          )}
        </>
      )}
    </>
  );
};

export default NotebookLayout;
