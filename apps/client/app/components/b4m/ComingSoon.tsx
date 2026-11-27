import SubscriberForm from '@client/app/components/SubscriberForm';
import { APP_NAME } from '@client/config/general';
import { Box, Typography } from '@mui/joy';

const ComingSoon = () => (
  <Box
    sx={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      gap: 2,
      px: 3,
      backgroundColor: 'background',
    }}
  >
    {/* brand name externalized to config */}
    <Typography level="h4">
      {APP_NAME ? `${APP_NAME} is coming soon!` : 'Coming soon!'} Enter your details to stay updated.
    </Typography>
    <Box sx={{ mt: 2 }}>
      <SubscriberForm source="coming_soon_page" />
    </Box>
  </Box>
);

export default ComingSoon;
