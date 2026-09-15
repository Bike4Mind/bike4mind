import React from 'react';
import { Box, IconButton, Typography } from '@mui/joy';
import { ArrowBack as ArrowBackIcon } from '@mui/icons-material';

interface MobileTopBarProps {
  title: string;
  onClose: () => void;
  rightContent?: React.ReactNode;
}

export const MobileTopBar: React.FC<MobileTopBarProps> = ({ title, onClose, rightContent }) => {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 0,
        p: 2,
        mb: 0,
        width: '100%',
        // borderBottom: '1px solid',
        // borderColor: 'divider',
        maxHeight: '56px',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'flex-start',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <IconButton
          variant="plain"
          onClick={onClose}
          sx={{
            width: '24px',
            height: '24px',
            minWidth: '24px',
            minHeight: '24px',
            justifyContent: 'flex-start',
            alignItems: 'center',
            p: 0,
            '& .MuiSvgIcon-root': {
              fontSize: '16px',
            },
            '&:hover': {
              backgroundColor: 'transparent',
            },
          }}
        >
          <ArrowBackIcon />
        </IconButton>
        <Typography sx={{ color: 'text.primary', fontSize: '14px', fontWeight: '500' }}>{title}</Typography>
      </Box>
      {rightContent && <Box>{rightContent}</Box>}
    </Box>
  );
};
