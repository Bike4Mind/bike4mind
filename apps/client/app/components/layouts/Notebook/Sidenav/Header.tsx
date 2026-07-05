import { useModalTrigger } from '@client/app/contexts/ModalTriggerContext';
import { useAppVersion } from '@client/app/hooks/useAppVersion';
import { openExternalLinkByKey } from '@client/app/utils/externalLinks';
import { useOptiAccess } from '@client/app/hooks/data/opti';
import { useTheme } from '@mui/joy/styles';
import { gray } from '@client/app/utils/themes/colors';
import CloseIcon from '@mui/icons-material/Close';
import FirstPageIcon from '@mui/icons-material/FirstPage';
import KeyboardTabIcon from '@mui/icons-material/KeyboardTab';
import NewspaperIcon from '@mui/icons-material/Newspaper';
import { AspectRatio, Box, IconButton, Tooltip } from '@mui/joy';
import { useIsTablet } from '@client/app/hooks/useIsMobile';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { useNotebookLayout } from '..';
import { useShallow } from 'zustand/react/shallow';
import useGetLogo from '@client/app/hooks/useGetLogo';

const SideNavHeader = () => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [openSideNav, setOpenSideNav] = useNotebookLayout(useShallow(s => [s.openSideNav, s.setOpenSideNav]));
  // Below `md` the sidebar is an overlay, so show a close (X) affordance
  // rather than the desktop collapse arrow.
  const isTablet = useIsTablet();
  const { triggerModalByTag } = useModalTrigger();
  const appVersion = useAppVersion();
  const navigate = useNavigate();
  // Entitlement-aware (admin/developer/OptiHashi Pro entitlement): the logo click
  // routes tag-less email-domain grantees to /opti too, not just `Opti`-tagged users.
  const isOptiUser = useOptiAccess();

  const handleLogoClick = () => {
    if (isOptiUser) {
      // @ts-expect-error - /opti is a premium route, not in static route tree
      navigate({ to: '/opti' });
    } else {
      openExternalLinkByKey('website');
    }
  };

  // Use custom logo if available, otherwise fallback to theme logo
  const logoSrc = useGetLogo();

  return (
    <Box
      className="notebook-sidenav-header-container"
      sx={theme => ({
        borderBottom: `1px solid ${theme.palette.mode === 'dark' ? gray[800] : gray[200]}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        p: '10px',
      })}
    >
      <AspectRatio className="notebook-sidenav-header-logo-container" ratio={1} sx={{ width: 32, height: 32 }}>
        <Tooltip
          title={`${theme.branding.name} v${appVersion.data?.version} - ${isOptiUser ? 'Go to OptiHashi' : 'Click to visit website'}`}
        >
          <Box
            className="notebook-sidenav-header-logo"
            component="div"
            onClick={handleLogoClick}
            sx={{
              cursor: 'pointer',
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={logoSrc}
              alt={`${theme.branding.name} logo`}
              loading="eager"
              style={{ objectFit: 'contain', width: '100%', height: '100%' }}
            />
          </Box>
        </Tooltip>
      </AspectRatio>
      <Box className="notebook-sidenav-header-actions" display="flex" gap="10px">
        <Tooltip title={t('whatsNew')}>
          <IconButton
            className="notebook-sidenav-header-whatsnew-button"
            sx={{ width: '36px', height: '36px', borderRadius: '8px' }}
            variant={'outlined'}
            color={'neutral'}
            onClick={() => triggerModalByTag('whats-new', 'WhatsNewSlider')}
          >
            <NewspaperIcon sx={{ fontSize: '18px' }} width={'24px'} height={'24px'} />
          </IconButton>
        </Tooltip>

        <Tooltip title="Collapse Sidebar">
          <IconButton
            className="notebook-sidenav-header-toggle-button"
            sx={{ width: '36px', height: '36px', borderRadius: '8px' }}
            variant={'outlined'}
            color={'neutral'}
            onClick={() => {
              if (openSideNav) {
                setOpenSideNav(false);
              } else {
                setOpenSideNav(true);
              }
            }}
          >
            {openSideNav ? (
              isTablet ? (
                <CloseIcon sx={{ fontSize: '18px' }} width="24px" height="24px" />
              ) : (
                <FirstPageIcon sx={{ fontSize: '18px' }} width={'24px'} height={'24px'} />
              )
            ) : (
              <KeyboardTabIcon sx={{ fontSize: '18px' }} width={'24px'} height={'24px'} />
            )}
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default SideNavHeader;
