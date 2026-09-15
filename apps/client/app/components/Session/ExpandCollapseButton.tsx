import React, { FC } from 'react';
import { Box, Button } from '@mui/joy';
import { ExpandMore, ExpandLess } from '@mui/icons-material';
import { blackAlpha } from '@client/app/utils/themes/colors';

interface ExpandCollapseButtonProps {
  needsTruncation: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

export const ExpandCollapseButton: FC<ExpandCollapseButtonProps> = ({ needsTruncation, isExpanded, onToggle }) => {
  if (!needsTruncation) {
    return null;
  }

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        mt: -2,
        position: 'relative',
        '&::before': {
          content: '""',
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '100%',
          height: '1px',
          zIndex: 0,
        },
      }}
    >
      <Button
        variant="outlined"
        size="sm"
        endDecorator={isExpanded ? <ExpandLess /> : <ExpandMore />}
        onClick={onToggle}
        sx={{
          backgroundColor: 'background.body',
          borderColor: theme => (theme.palette.mode === 'dark' ? 'neutral.700' : 'neutral.300'),
          color: 'text.primary',
          fontSize: '0.75rem',
          fontWeight: 500,
          px: 2,
          py: 0.75,
          minHeight: 'auto',
          borderRadius: '20px',
          position: 'relative',
          zIndex: 1,
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          '&:hover': {
            backgroundColor: 'background.level1',
            color: 'text.primary',
            transform: 'translateY(-1px)',
            boxShadow: `0 4px 8px -2px ${blackAlpha[0][10]}`,
          },
          '&:active': {
            transform: 'translateY(0)',
            boxShadow: `0 2px 4px -1px ${blackAlpha[0][10]}`,
          },
        }}
      >
        {isExpanded ? 'Show Less' : 'Show More'}
      </Button>
    </Box>
  );
};
