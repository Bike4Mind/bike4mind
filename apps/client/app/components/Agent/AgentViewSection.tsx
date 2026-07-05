import React from 'react';
import { Box, Typography } from '@mui/joy';

interface AgentViewSectionProps {
  title: string;
  children: React.ReactNode;
}

const AgentViewSection: React.FC<AgentViewSectionProps> = ({ title, children }) => {
  return (
    <Box
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: theme => `1px solid ${theme.palette.border.soft}`,
        borderRadius: '8px',
        p: { xs: 2, sm: 3 },
        height: '100%',
      }}
    >
      <Typography level="title-md" sx={{ mb: 0 }}>
        {title}
      </Typography>

      {children}
    </Box>
  );
};

export default AgentViewSection;
