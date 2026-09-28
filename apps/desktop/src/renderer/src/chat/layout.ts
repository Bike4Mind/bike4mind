import type { SxProps } from '@mui/joy/styles/types';

/**
 * Reading width for the conversation, in px.
 *
 * A line of prose stops being comfortable to read somewhere past ~90 characters, and on a
 * maximised window the thread would otherwise run the full width of the display. The thread,
 * the composer and the header all share this so they stay in one visual column.
 */
export const CONTENT_MAX_WIDTH = 760;

/** Centered reading column. Applied to the INNER element, so the scrollbar stays at the pane edge. */
export const contentColumnSx: SxProps = {
  width: '100%',
  maxWidth: CONTENT_MAX_WIDTH,
  mx: 'auto',
  px: 3,
};
