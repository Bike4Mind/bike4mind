import type { SxProps } from '@mui/joy/styles/types';

/**
 * A full-height screen that centres its card and scrolls inside itself when the card is taller:
 * the document is locked to the window (see viewport.css), so this box is the only scroll there is.
 */
export const centeredScreenSx: SxProps = {
  height: '100vh',
  overflowY: 'auto',
  display: 'grid',
  placeItems: 'safe center',
  bgcolor: 'background.body',
  p: 3,
};
