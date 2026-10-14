import { FC, ReactNode } from 'react';
import { Box } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';

interface ComposerStatusLineProps {
  left?: ReactNode;
  right?: ReactNode;
  sx?: SxProps;
}

/**
 * Quiet line above the composer box for notebook and account state (the balance, and next the
 * notebook's files). What travels with the message stays inside the box. The caller sizes it to
 * match the box, since the two are siblings.
 */
const ComposerStatusLine: FC<ComposerStatusLineProps> = ({ left, right, sx }) => (
  <Box
    data-testid="composer-status-line"
    sx={[
      {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1,
        px: '8px',
        py: '4px',
      },
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>{left}</Box>
    <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{right}</Box>
  </Box>
);

export default ComposerStatusLine;
