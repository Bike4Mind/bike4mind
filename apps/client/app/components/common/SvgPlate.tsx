import React from 'react';
import { Box } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';

interface SvgPlateProps {
  children: React.ReactNode;
  testId?: string;
  sx?: SxProps;
}

/**
 * Fixed white plate under an SVG image in both color schemes. An SVG is authored artwork and cannot
 * be re-themed: strokes drawn for a light canvas, or left as currentColor (black in image mode),
 * vanish on a dark surface, so it gets the canvas most artwork assumes.
 */
const SvgPlate: React.FC<SvgPlateProps> = ({ children, testId, sx }) => (
  <Box
    data-testid={testId}
    sx={[
      {
        display: 'flex',
        justifyContent: 'center',
        boxSizing: 'border-box',
        backgroundColor: '#FFFFFF',
        borderRadius: '6px',
        p: 1,
      },
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
  >
    {children}
  </Box>
);

export default SvgPlate;
