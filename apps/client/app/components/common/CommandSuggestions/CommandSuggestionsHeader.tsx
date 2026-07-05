import React from 'react';
import { Box, Typography } from '@mui/joy';

interface CommandSuggestionsHeaderProps {
  title: string;
  subtitle?: string;
}

export const CommandSuggestionsHeader: React.FC<CommandSuggestionsHeaderProps> = ({
  title,
  subtitle = '↑↓ to navigate, enter to select, [1]-[9] for quick select',
}) => {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        p: '12px 16px',
        gap: '4px',
        borderBottom: '1px solid',
        borderColor: 'border.soft',
        mb: 0,
      }}
    >
      <Typography level="body-xs" sx={{ mb: 0, px: 0, color: 'text.primary', fontSize: '14px' }}>
        {title}
      </Typography>
      <Typography level="body-xs" sx={{ color: 'text.primary50', fontSize: '13px' }}>
        {subtitle}
      </Typography>
    </Box>
  );
};
