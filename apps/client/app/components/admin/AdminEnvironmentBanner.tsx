import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import CloseIcon from '@mui/icons-material/Close';
import HelpCenterIcon from '@mui/icons-material/HelpCenter';
import { Box, IconButton, Tooltip, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { environmentBannerPalette } from '@client/app/utils/themes/admin';
import { resolveCurrentEnvironment } from './environmentBanner';
import { adminFocus } from './shared/adminStyles';

const { foreground } = environmentBannerPalette;
const bannerButtonSx = {
  '--IconButton-size': '20px',
  minWidth: 20,
  minHeight: 20,
  padding: 0,
  borderRadius: '4px',
  color: foreground,
  '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.14)', color: foreground },
  ...adminFocus,
};
const bannerIconSx = { fontSize: 14, color: 'inherit' };

/** The strip naming the environment. It sits outside `data-admin-surface`, so the admin skin never reaches it. */
const EnvironmentBanner = () => {
  const navigate = useNavigate();
  const { environment, environmentName } = resolveCurrentEnvironment();

  return (
    <Box
      data-testid="environment-banner"
      sx={{
        backgroundColor: environmentBannerPalette.background[environment],
        color: foreground,
        px: 1,
        flexShrink: 0,
        zIndex: 1100,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        height: '24px',
        boxSizing: 'border-box',
      }}
    >
      <Box flexBasis="44px" />
      <Typography
        data-testid="environment-banner-title"
        level="body-xs"
        sx={{
          color: foreground,
          fontSize: '12px',
          fontWeight: 500,
          lineHeight: '16px',
          flexGrow: 1,
          textAlign: 'center',
        }}
      >
        {environmentName}
      </Typography>
      <Box sx={{ display: 'flex', gap: '4px' }}>
        <Tooltip title="Help Center" placement="bottom">
          <IconButton
            onClick={() => openHelpPanel()}
            sx={bannerButtonSx}
            size="sm"
            aria-label="Open Help Center"
            data-testid="admin-help-center-btn"
          >
            <HelpCenterIcon sx={bannerIconSx} />
          </IconButton>
        </Tooltip>
        <IconButton onClick={() => navigate({ to: '/' })} sx={bannerButtonSx} size="sm" aria-label="Leave admin">
          <CloseIcon sx={bannerIconSx} data-testid="close-admin-page-banner-btn" />
        </IconButton>
      </Box>
    </Box>
  );
};

export default EnvironmentBanner;
