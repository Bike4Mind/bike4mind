import React from 'react';
import { Box } from '@mui/joy';

interface ShimmerWrapperProps {
  children: React.ReactNode;
  isShimmering: boolean;
  fieldName: string;
}

// Shimmer overlay used for dice-roll effects.
const ShimmerWrapper = ({ children, isShimmering, fieldName }: ShimmerWrapperProps) => {
  return (
    <Box
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '6px',
        transition: 'all 0.2s ease',
      }}
    >
      {children}
      {isShimmering && (
        <>
          {/* Main shimmer effect */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: '-100%',
              width: '100%',
              height: '100%',
              background:
                'linear-gradient(120deg, transparent, rgba(11, 107, 203, 0.07), rgba(11, 107, 203, 0.12), rgba(11, 107, 203, 0.05), transparent)',
              animation: 'shimmer 600ms ease-out',
              pointerEvents: 'none',
              borderRadius: '6px',
              zIndex: 1,
              '@keyframes shimmer': {
                '0%': {
                  left: '-100%',
                },
                '100%': {
                  left: '100%',
                },
              },
            }}
          />
        </>
      )}
    </Box>
  );
};

export default ShimmerWrapper;
