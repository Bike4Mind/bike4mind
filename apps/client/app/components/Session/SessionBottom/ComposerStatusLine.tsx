import { FC, ReactNode } from 'react';
import { Box } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';

interface ComposerStatusLineProps {
  left?: ReactNode;
  right?: ReactNode;
  sx?: SxProps;
}

const ITEM_GAP = '8px';

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
        // 36px tall with the 24px items. SessionMiddle's scroll-to-bottom button hangs into this
        // line by its height minus 16px - keep in sync.
        pt: '8px',
        pb: '4px',
      },
      ...(Array.isArray(sx) ? sx : [sx]),
    ]}
  >
    {/* One gap between items on both sides; each item adds its own ~6px padding on top. */}
    <Box sx={{ display: 'flex', alignItems: 'center', gap: ITEM_GAP, minWidth: 0 }}>{left}</Box>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: ITEM_GAP, flexShrink: 0 }}>{right}</Box>
  </Box>
);

export default ComposerStatusLine;
