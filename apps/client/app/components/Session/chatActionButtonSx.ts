// Narrow viewport or a touch-first pointer: where a 24px target is too small to hit.
export const TOUCH_TARGET_QUERY = '@media (max-width: 639.95px), (pointer: coarse)';

/**
 * The action affordances under a reply (more, copy, download, report, share) and the
 * edit button under a prompt: a 24px frame around a 16px glyph.
 *
 * Joy sizes IconButton from --IconButton-size, so plain width/height lose to its own
 * minWidth/minHeight defaults; the glyph is set through --Icon-fontSize for the same
 * reason. Shared so the row cannot drift one button at a time.
 *
 * On narrow or touch screens the frame grows to a 44px hit area while the glyph stays 16px.
 */
export const chatActionButtonSx = {
  '--IconButton-size': '24px',
  '--Icon-fontSize': '16px',
  minWidth: '24px',
  minHeight: '24px',
  flexShrink: 0,
  borderRadius: '6px',
  '& svg': { width: '16px', height: '16px' },
  // Secondary to the message they sit under: half strength at rest, full on the one the
  // pointer is over. focus-visible matches it, or a keyboard user would tab through a row
  // that never brightens.
  opacity: 0.5,
  transition: 'opacity 150ms ease',
  '&:hover': { opacity: 1 },
  '&:focus-visible': { opacity: 1 },
  [TOUCH_TARGET_QUERY]: {
    '--IconButton-size': '44px',
    minWidth: '44px',
    minHeight: '44px',
  },
} as const;
