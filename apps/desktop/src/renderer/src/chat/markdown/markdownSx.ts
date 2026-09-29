import type { SxProps } from '@mui/joy/styles/types';

/**
 * Markdown prose, styled through Joy tokens so it follows both themes without a second palette.
 *
 * The container carries the `body-sm` scale the reply was set in before it was markdown, so a
 * plain paragraph reads exactly as it used to and only the structure around it is new.
 *
 * The first and last child have their outer margins removed: rounds are spaced by the `mt` in
 * MessageThread, and a paragraph's own margin on top of that would make a multi-round reply
 * drift apart.
 */
export const markdownSx: SxProps = {
  minWidth: 0,
  color: 'var(--joy-palette-text-primary)',
  fontFamily: 'var(--joy-fontFamily-body)',
  fontSize: 'var(--joy-fontSize-sm)',
  lineHeight: 'var(--joy-lineHeight-md)',
  wordBreak: 'break-word',

  '& > *:first-of-type': { mt: 0 },
  '& > *:last-child': { mb: 0 },

  '& p': { my: 1 },

  '& h1, & h2, & h3, & h4, & h5, & h6': {
    fontFamily: 'var(--joy-fontFamily-display)',
    fontWeight: 'var(--joy-fontWeight-lg)',
    lineHeight: 'var(--joy-lineHeight-sm)',
    mt: 2,
    mb: 1,
  },
  '& h1': { fontSize: 'var(--joy-fontSize-lg)' },
  '& h2': { fontSize: 'var(--joy-fontSize-md)' },
  '& h3, & h4, & h5, & h6': { fontSize: 'var(--joy-fontSize-sm)' },
  // A heading that opens a round would otherwise sit tight against the round above it.
  '& h1:not(:first-of-type), & h2:not(:first-of-type)': { mt: 2.5 },

  '& ul, & ol': { my: 1, pl: 3 },
  '& li': { my: 0.25 },
  // Nested lists are already inside a spaced li, so their own vertical margin doubles it up.
  '& li > ul, & li > ol': { my: 0.25 },
  '& li::marker': { color: 'var(--joy-palette-text-tertiary)' },

  '& blockquote': {
    my: 1,
    ml: 0,
    pl: 2,
    borderLeft: '3px solid var(--joy-palette-neutral-outlinedBorder)',
    color: 'var(--joy-palette-text-secondary)',
  },

  '& hr': {
    my: 2,
    border: 'none',
    borderTop: '1px solid var(--joy-palette-divider)',
  },

  '& a': {
    color: 'var(--joy-palette-primary-plainColor)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },

  // Anything but a fenced block, which CodeBlock draws with its own container.
  '& :not(pre) > code': {
    fontFamily: 'var(--joy-fontFamily-code)',
    fontSize: '0.875em',
    px: 0.5,
    py: 0.125,
    borderRadius: 'var(--joy-radius-xs)',
    backgroundColor: 'var(--joy-palette-background-level2)',
    color: 'var(--joy-palette-text-primary)',
  },

  // Scrolls on its own so a wide table widens the column rather than the whole thread.
  '& table': {
    display: 'block',
    width: 'fit-content',
    maxWidth: '100%',
    overflowX: 'auto',
    my: 1.5,
    borderCollapse: 'collapse',
    fontSize: 'var(--joy-fontSize-xs)',
  },
  '& th, & td': {
    border: '1px solid var(--joy-palette-divider)',
    px: 1,
    py: 0.5,
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '& th': {
    backgroundColor: 'var(--joy-palette-background-level1)',
    fontWeight: 'var(--joy-fontWeight-lg)',
  },

  '& img': { maxWidth: '100%', height: 'auto', borderRadius: 'var(--joy-radius-sm)' },
};

/** The container a fenced block is drawn in: its own surface, scrolling sideways on its own. */
export const codeBlockSx: SxProps = {
  my: 1.5,
  p: 1.5,
  overflowX: 'auto',
  borderRadius: 'var(--joy-radius-sm)',
  backgroundColor: 'var(--joy-palette-background-level1)',
  border: '1px solid var(--joy-palette-divider)',
};
