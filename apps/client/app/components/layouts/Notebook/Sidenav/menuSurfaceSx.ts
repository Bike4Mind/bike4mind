import type { Theme } from '@mui/joy/styles';

/**
 * Shared look for the app's floating menu surfaces (the profile menu, its "More" flyout, the
 * Data Lake file-row menu). One recipe so a tweak to the ground or the lift reaches all of
 * them. Callers own placement and corner radius - the profile panel and the Data Lake menu
 * use 8px, the More flyout 12px.
 */
export const menuSurfaceSx = (theme: Theme) => ({
  backgroundColor: theme.palette.background.surface,
  border: `1px solid ${theme.palette.divider}`,
  // Soft, diffuse lift (same recipe as the tutorial frame): a wide low-opacity ambient layer
  // plus a tighter contact layer, stronger in dark mode where light shadows disappear.
  boxShadow:
    theme.palette.mode === 'dark'
      ? '0 24px 70px rgba(0, 0, 0, 0.28), 0 8px 20px rgba(0, 0, 0, 0.14)'
      : '0 24px 30px rgba(0, 0, 0, 0.03), 0 8px 20px rgba(0, 0, 0, 0.02)',
  p: 1,
});

/**
 * A single icon + label row inside a menuSurfaceSx panel. `danger` tints a destructive row.
 * Joy sets its own hover background from `--variant-plainHoverBg`, so consumers built on Joy
 * MenuItem must ALSO point that variable at the hover colour or Joy's rule wins.
 */
export const menuRowSx = (theme: Theme, danger = false) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  px: '10px',
  height: '40px',
  borderRadius: '8px',
  cursor: 'pointer',
  color: danger ? theme.palette.danger[500] : theme.palette.sidenav?.navItemText,
  // Joy icons - and the Credits Bike4MindIcon, which fills with var(--Icon-color) - read
  // --Icon-color, not `color`. Tint them brand light-blue @50% (text.tertiary).
  '--Icon-color': danger ? theme.palette.danger[500] : theme.palette.text.tertiary,
  transition: 'background 0.15s',
  '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
  '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
});

/** Fixed box the row's icon sits in, so labels align regardless of glyph width. */
export const MENU_ROW_ICON_SX = {
  width: 22,
  height: 22,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
} as const;
