import React from 'react';
import { Box, Typography } from '@mui/joy';
import { useUser } from '@client/app/contexts/UserContext';
import SecurityTabLayout from './SecurityTabLayout';

const SecurityTab: React.FC = () => {
  const { currentUser } = useUser();

  if (!currentUser?.isAdmin) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography level="h4" sx={{ mb: 1 }}>
          Security dashboard unavailable
        </Typography>
        <Typography level="body-sm" color="neutral">
          Security insights are limited to workspace administrators. Please contact your admin if you need access.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }} data-testid="security-tab-root">
      <SecurityTabLayout />
    </Box>
  );
};

export default SecurityTab;
