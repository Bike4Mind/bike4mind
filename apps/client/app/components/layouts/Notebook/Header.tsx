import Sheet from '@mui/joy/Sheet';
import IconButton from '@mui/joy/IconButton';
import Box from '@mui/joy/Box';
import MenuIcon from '@mui/icons-material/Menu';
import MapsUgcOutlinedIcon from '@mui/icons-material/MapsUgcOutlined';
import { useNotebookLayout } from './index';
import { useShallow } from 'zustand/react/shallow';
import { useTheme } from '@mui/joy';
import SessionSidenavItem from '@client/app/components/Session/SidenavItem';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useRouter, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useNotebookSearch } from '@client/app/contexts/NotebookSearchContext';
import SearchBarWithToggle from '@client/app/components/Session/SearchBarWithToggle';
import { useGetFavoriteSessions } from '@client/app/hooks/data/sessions';
import { gray } from '@client/app/utils/themes/colors';
import SessionOwnerBadge from '@client/app/components/Session/SessionOwnerBadge';
import Typography from '@mui/joy/Typography';
import { useMobileHeaderStore } from '@client/app/hooks/useMobileHeader';
import { gearsMenuDot, useGearsNavSignal } from '@client/app/hooks/useVisibleGears';
import { rewardGreen } from '@client/app/components/common/gearRewardStyles';

const NotebookHeader = () => {
  const [openSideNav, setOpenSideNav, showMessageCounts] = useNotebookLayout(
    useShallow(s => [s.openSideNav, s.setOpenSideNav, s.showMessageCounts])
  );
  const theme = useTheme();
  const mode = theme.palette.mode;
  const { currentSession } = useSessions();
  const router = useRouter();
  const navigate = useNavigate();
  const isNotebookPage = router.state.location.pathname.startsWith('/notebooks/');
  const { setSearch } = useNotebookSearch();
  const { t } = useTranslation();
  const { data: favoriteSessions = [] } = useGetFavoriteSessions();
  const pageTitle = useMobileHeaderStore(s => s.title);
  const pageAction = useMobileHeaderStore(s => s.action);
  // The phone's sidenav is behind this button, so the tag on its Gears row is
  // unseen until the menu is opened; a dot stands in for it.
  const menuDot = gearsMenuDot(useGearsNavSignal());

  return (
    <Sheet
      className="notebook-header-container"
      sx={{
        display: { xs: 'flex', sm: 'none' },
        alignItems: 'center',
        position: 'fixed',
        top: 0,
        width: '100vw',
        height: 'var(--notebook-header-height)',
        zIndex: 'var(--joy-zIndex-appBar, 1)',
        padding: '12px 16px',
        gap: 1,
        borderBottom: `1px solid ${mode === 'dark' ? gray[800] : gray[200]}`,
        boxShadow: mode === 'dark' ? '0px 4px 10px 0px #0E12141A' : '0px 2px 10px 0px #0F131505',
        backgroundColor: theme => theme.palette.background.surface2,
      }}
    >
      <IconButton
        className="notebook-header-menu-button"
        variant="outlined"
        color="neutral"
        size="sm"
        onClick={() => {
          setOpenSideNav(!openSideNav);
        }}
        sx={{ position: 'relative' }}
      >
        <MenuIcon />
        {menuDot && (
          <Box
            component="span"
            aria-hidden
            data-testid={`mobile-header-menu-dot-${menuDot}`}
            sx={theme => ({
              position: 'absolute',
              top: '-4px',
              right: '-4px',
              width: '10px',
              height: '10px',
              borderRadius: '50%',
              // Start here's own tag is neutral, which a bare dot cannot be and still
              // be seen - so it takes the text colour, and the reward its green.
              backgroundColor: menuDot === 'claim' ? rewardGreen(theme).ink : theme.palette.text.primary,
            })}
          />
        )}
      </IconButton>
      {isNotebookPage && currentSession ? (
        <Box
          className="notebook-header-session-container"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            ml: 'auto',
            gap: '20px',
            position: 'relative',
          }}
        >
          {/* Session Sidenav Item and Owner Badge */}
          <Box
            className="notebook-header-session-item"
            sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 0 }}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <SessionSidenavItem
                session={currentSession}
                location="header"
                favoriteSessions={favoriteSessions}
                showMessageCount={showMessageCounts}
              />
            </Box>
            <SessionOwnerBadge session={currentSession} variant="compact" />
          </Box>

          {/* Icon Buttons */}
          <Box
            className="notebook-header-buttons-container"
            sx={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
          >
            <SearchBarWithToggle handleChange={setSearch} placeHolder={t('search')} />

            {/* New Note Button */}
            <IconButton
              className="notebook-header-new-note-button"
              onClick={() => {
                setOpenSideNav(false);
                navigate({ to: '/new' });
              }}
              variant="solid"
              color="primary"
              size="sm"
            >
              <MapsUgcOutlinedIcon fontSize="small" />
            </IconButton>
          </Box>
        </Box>
      ) : pageTitle ? (
        <>
          {/* Centred on the header, not on the space left by the menu button: the
              right slot is as wide as that button even when empty. */}
          <Typography
            data-testid="mobile-header-title"
            noWrap
            sx={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: '16px', fontWeight: 500, color: 'text.primary' }}
          >
            {pageTitle}
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', minWidth: '32px' }}>{pageAction}</Box>
        </>
      ) : null}
    </Sheet>
  );
};

export default NotebookHeader;
