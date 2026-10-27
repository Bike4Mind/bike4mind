import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import CloseIcon from '@mui/icons-material/Close';
import HelpCenterIcon from '@mui/icons-material/HelpCenter';
import { Box, IconButton, Tooltip, Typography } from '@mui/joy';
import { useRouter } from '@tanstack/react-router';
import { resolveEnvironmentBanner } from './environmentBanner';

/** The coloured strip naming the environment. It sits outside `data-admin-surface`, so the admin skin never reaches it. */
const EnvironmentBanner = () => {
  const router = useRouter();
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  const { bannerColor, environmentName } = resolveEnvironmentBanner(hostname, process.env.NEXT_PUBLIC_SERVER_DOMAIN);

  return (
    <Box
      sx={{
        backgroundColor: bannerColor,
        color: 'white',
        padding: '4px 8px',
        textAlign: 'center',
        fontWeight: 'bold',
        position: 'sticky',
        top: 0,
        zIndex: 1100,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        height: '32px',
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
            sx={{
              color: 'white',
              padding: '4px',
              '&:hover': {
                backgroundColor: 'rgba(255, 255, 255, 0.2)',
              },
            }}
            size="sm"
            data-testid="admin-help-center-btn"
          >
            <HelpCenterIcon fontSize="small" sx={{ color: 'white' }} />
          </IconButton>
        </Tooltip>
        <IconButton
          onClick={() => router.history.back()}
          sx={{
            color: 'white',
            padding: '4px',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
            },
          }}
          size="sm"
        >
          <CloseIcon fontSize="small" sx={{ color: 'white' }} data-testid="close-admin-page-banner-btn" />
        </IconButton>
      </Box>
    </Box>
  );
};

export default EnvironmentBanner;
