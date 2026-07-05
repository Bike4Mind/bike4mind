import { CircularProgress, Box, Typography } from '@mui/joy';
import { FC, useEffect } from 'react';
import { useSessionResumption } from '@client/app/hooks/useSessionResumption';

const HomePage: FC = () => {
  const { navigateToSession, isLoading, shouldResume, lastSessionId } = useSessionResumption({
    maxIdleMinutes: 60, // Resume if less than 60 minutes idle
    alwaysCreateNew: false,
  });

  useEffect(() => {
    if (!isLoading) {
      console.log(`🚀 Session resumption decision: ${shouldResume ? 'Resume' : 'New'} (sessionId: ${lastSessionId})`);
      navigateToSession();
    }
  }, [isLoading, navigateToSession, shouldResume, lastSessionId]);

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}
    >
      <CircularProgress sx={{ width: 200, mb: 2 }} />
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        {isLoading ? 'Checking session...' : shouldResume ? 'Resuming your work...' : 'Starting fresh...'}
      </Typography>
    </Box>
  );
};

export default HomePage;
