/**
 * The action affordances under a reply (more, copy, download, report, share) and the
 * edit button under a prompt: a 24px frame around a 16px glyph.
 *
 * Joy sizes IconButton from --IconButton-size, so plain width/height lose to its own
 * minWidth/minHeight defaults; the glyph is set through --Icon-fontSize for the same
 * reason. Shared so the row cannot drift one button at a time.
 */
export const chatActionButtonSx = {
  '--IconButton-size': '24px',
  '--Icon-fontSize': '16px',
  minWidth: '24px',
  minHeight: '24px',
  flexShrink: 0,
  borderRadius: '6px',
  '& svg': { width: '16px', height: '16px' },
} as const;
