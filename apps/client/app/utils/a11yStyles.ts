/**
 * Shared accessibility style helpers.
 */

/**
 * Visually hides an element while keeping it available to screen readers and
 * other assistive tech (the standard "visually hidden" / SR-only pattern).
 * Use as an `sx` value, e.g. `<FormLabel sx={visuallyHidden}>Email</FormLabel>`.
 */
export const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;
