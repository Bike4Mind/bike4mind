import Grid from '@mui/joy/Grid';
import { FC, PropsWithChildren, ReactNode, useEffect, useState } from 'react';
import NotebookSideNav from './Sidenav';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { Box, Drawer } from '@mui/joy';
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
import useSessionLayout from '@client/app/hooks/useSessionLayout';

export interface NotebookLayoutProps {
  children: ReactNode;
}

interface NotebookLayoutState {
  openSideNav: boolean;
  setOpenSideNav: (val: boolean) => void;
  showMessageCounts: boolean;
  setShowMessageCounts: (val: boolean) => void;
}

export const useNotebookLayout = create<NotebookLayoutState>()(
  persist(
    set => ({
      openSideNav: true,
      setOpenSideNav: (val: boolean) => set({ openSideNav: val }),
      showMessageCounts: false,
      setShowMessageCounts: (val: boolean) => set({ showMessageCounts: val }),
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
  const isImpersonating = useAccessToken(s => s.returnToken);
  const layout = useSessionLayout(s => s.layout);

  // Global keyboard shortcuts
  useHelpKeyboardShortcut();
  useCommandPaletteShortcut();

  // Knowledge viewer is open when layout is not 'hide'
  const isKnowledgeViewerOpen = layout !== 'hide';

  const getContentPadding = (): string => {
    if (isMobile) return '0px';
    if (openSideNav && isKnowledgeViewerOpen) return '12px 12px 12px 12px';
    if (openSideNav) return '12px 12px 12px 12px';
    if (isKnowledgeViewerOpen) return '12px 12px 12px 36px';
    return '12px 12px 12px 36px';
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

      {/* Main */}
      <Grid
        className="notebook-layout-main"
        sx={{
          position: 'relative',
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
