import NetworkStatus from '@client/app/components/NetworkStatus';
import { useIsPWA } from '@client/app/hooks/useIsPWA';
import { isLocalhost } from '@client/app/utils/isLocalhost';
import { Box } from '@mui/joy';
import ProfileMenu from './ProfileMenu';

const SidenavFooter = () => {
  const isPWA = useIsPWA();

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
      {/* Network / service-worker / websocket status pills — localhost only */}
      {isLocalhost && (
        <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px' }}>
          <NetworkStatus />
        </Box>
      )}

      {/* Account + account menu */}
      <ProfileMenu />
    </Box>
  );
};

export default SidenavFooter;
