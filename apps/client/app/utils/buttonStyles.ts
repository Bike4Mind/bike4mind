/**
 * Metrics for a compact action button - the size the app's secondary actions share:
 * the active-brief card's footer row and the chat's suggested-navigation buttons.
 *
 * Height goes through Joy's own var, which its root style reads. The inline padding
 * is set directly: Joy hardcodes that one per size and offers no var to aim at.
 */
export const compactButtonSx = {
  fontSize: '13px',
  fontWeight: 500,
  paddingInline: '12px',
  '--Button-minHeight': '32px',
};
