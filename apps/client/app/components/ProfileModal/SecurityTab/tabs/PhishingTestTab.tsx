import React from 'react';
import { Box, Sheet, Typography, useTheme } from '@mui/joy';
import { MailOutlined } from '@mui/icons-material';

const PhishingTestTab: React.FC = () => {
  const theme = useTheme();

  return (
    <Box data-testid="phishing-test-tab" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Header */}
      <Sheet variant="outlined" sx={{ borderRadius: 'md', p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <MailOutlined sx={{ color: theme.palette.security.good.plainColor }} />
          <Typography level="title-md">Last Phishing Test</Typography>
        </Box>
        <Typography level="body-xs" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
          Phishing simulation results for your account
        </Typography>
      </Sheet>

      {/* Coming soon */}
      <Sheet
        variant="soft"
        sx={{
          borderRadius: 'lg',
          p: 6,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
        }}
      >
        <MailOutlined sx={{ fontSize: 48, color: theme.palette.neutral.plainColor, opacity: 0.4 }} />
        <Typography level="title-md" sx={{ color: theme.palette.text.secondary }}>
          Coming Soon
        </Typography>
        <Typography level="body-sm" sx={{ color: theme.palette.text.tertiary, maxWidth: 400 }}>
          Phishing simulation data is not yet available. This feature is coming soon.
        </Typography>
      </Sheet>
    </Box>
  );
};

export default PhishingTestTab;
