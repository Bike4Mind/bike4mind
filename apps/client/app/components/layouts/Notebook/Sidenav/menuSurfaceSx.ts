import type { Theme } from '@mui/joy/styles';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

/**
 * The one inset a menu surface and the list on it both use - menuSurfaceSx as padding,
 * menuListSx as Joy's --List-padding. Shared rather than restated so the two cannot drift:
 * the content sits the same distance from the edge whether the surface is a List or a Box.
 */
const MENU_INSET = '8px';

/**
 * Shared look for the app's floating menu surfaces (the profile menu, its "More" flyout, the
 * Data Lake row and lake menus, the chat panel's layout Select). One recipe so a tweak to the
 * ground or the lift reaches all of them. `radius` is the surface's own corner: the profile
 * panel and the Data Lake menus use 8px, the More flyout 12px.
 *
 * Anything on this ground that renders as a Joy List - a Menu, a Select listbox - wants
 * menuListSx too, and a Select's listbox wants selectListboxSx.
 */
export const menuSurfaceSx = (theme: Theme, radius = '8px') => ({
  backgroundColor: theme.palette.background.surface,
  border: `1px solid ${theme.palette.divider}`,
  borderRadius: radius,
  // Soft, diffuse lift (same recipe as the tutorial frame): a wide low-opacity ambient layer
  // plus a tighter contact layer, stronger in dark mode where light shadows disappear.
  boxShadow:
    theme.palette.mode === 'dark'
      ? '0 24px 70px rgba(0, 0, 0, 0.28), 0 8px 20px rgba(0, 0, 0, 0.14)'
      : '0 24px 30px rgba(0, 0, 0, 0.03), 0 8px 20px rgba(0, 0, 0, 0.02)',
  p: MENU_INSET,
});

/**
 * List-container half of a menuSurfaceSx panel: Joy's --List-* tokens plus the app's own 4px
 * scrollbar thumb. Joy gives both its Menu and its Select listbox `overflow: auto`, so any of
 * these can scroll, and without the thumb a long menu falls back to the platform's chunky
 * light-grey rail. Joy drives a List's padding and its rows' geometry from variables, so these
 * have to be set as variables and not as plain padding/gap.
 *
 * --ListItem-radius is pinned rather than left to Joy, which DERIVES a smaller child radius from
 * --List-radius and --List-padding (8/8 comes out at 4px) - the reason the menus disagreed about
 * their row corners. Rows are 8px whatever the surface's own corner is, so both stay literals:
 * --List-radius is only the derivation's input, and menuSurfaceSx owns the corner you see.
 *
 * `gap` is the only knob: 4px for a Select's listbox, 2px for the denser action menus. The
 * padding is MENU_INSET, the same constant menuSurfaceSx pads with, so the two stay equal by
 * construction.
 */
export const menuListSx = ({ gap = '4px' }: { gap?: string } = {}) => ({
  '--List-padding': MENU_INSET,
  '--List-radius': '8px',
  '--List-gap': gap,
  '--ListItem-radius': '8px',
  ...scrollbarStyles,
});

/**
 * A Select's listbox on a menuSurfaceSx ground: menuListSx plus the option rows' hover, selected
 * and focus states, so every Select in the app marks a row the same way.
 *
 * Joy paints an Option's hover, its keyboard-highlighted row and its press from
 * --variant-plain*Bg, so pointing those variables at the colour is what wins - a bare `&:hover`
 * rule loses to Joy's own. The selected ground cannot go through a variable, because Joy's
 * Option (unlike its AutocompleteOption) has no rule for the selected row at all; it is a plain
 * declaration that outweighs Joy's `:active` on specificity.
 *
 * Scoped to [role="option"], so spreading it on a Joy Menu is inert - Menu rows are
 * role="menuitem" and take menuRowSx per item, which owns the danger variant too.
 *
 * Not every Select in the app belongs here: the model-filter, file-browser and upload dropdowns
 * (Session/ModelSelection, Files/Browser/MobileSearchFilter, Files/Browser/UploadActionsSelect)
 * deliberately sit on background.body with no border, which is a different surface, not a
 * drifted copy of this one.
 */
export const selectListboxSx = (theme: Theme, opts?: { gap?: string }) => ({
  ...menuListSx(opts),
  '& [role="option"]': {
    borderRadius: '8px',
    transition: 'background 0.15s',
    '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
    '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
    '&[aria-selected="true"]': {
      backgroundColor: theme.palette.notebooklist.focusedBackground,
      fontWeight: 600,
      // Joy's base plain variant paints EVERY Option's ink from --variant-plainColor; `inherit`
      // drops the selected row back to the listbox's own ink, so the bold weight marks it rather
      // than a different colour. (Nothing repaints on press - plainActive carries no `color`.)
      color: 'inherit',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.palette.primary[500]}`,
      outlineOffset: '-2px',
    },
  },
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
