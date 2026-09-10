import NetworkStatus from '@client/app/components/NetworkStatus';
import { useIsPWA } from '@client/app/hooks/useIsPWA';
import { isLocalhost } from '@client/app/utils/isLocalhost';
import { Box, Button } from '@mui/joy';
import ProfileMenu from './ProfileMenu';
import { useScrollDebug } from '@client/app/hooks/useScrollDebug';

const SidenavFooter = () => {
  const isPWA = useIsPWA();
  const { active: scrollDebugActive, toggle: toggleScrollDebug } = useScrollDebug();

  return (
    <Box
      data-testid="notebook-sidenav-footer"
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        p: isPWA ? '10px 16px 24px 16px' : '10px 16px 16px 16px',
        backgroundColor: theme.palette.background.surface2,
      })}
    >
      {/* Network / service-worker / websocket status pills + scroll debug - localhost only */}
      {isLocalhost && (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <NetworkStatus />
          <Button
            data-testid="debug-fill-scrollbars-btn"
            size="sm"
            variant={scrollDebugActive ? 'solid' : 'outlined'}
            color="warning"
            onClick={toggleScrollDebug}
            sx={{ fontSize: '11px', py: '2px', px: '8px' }}
          >
            {scrollDebugActive ? 'Clear Scroll Fill' : 'Fill Scrollbars'}
          </Button>
        </Box>
      )}

      {/* Account + account menu */}
      <ProfileMenu />
    </Box>
  );
};

export default SidenavFooter;
