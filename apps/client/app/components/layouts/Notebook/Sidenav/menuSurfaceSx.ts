import type { Theme } from '@mui/joy/styles';
import menuItemClasses from '@mui/joy/MenuItem/menuItemClasses';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

/**
 * The one inset a menu surface and the list on it both use - menuSurfaceSx as padding,
 * menuListSx as Joy's --List-padding. Shared rather than restated so the two cannot drift:
 * the content sits the same distance from the edge whether the surface is a List or a Box.
 */
const MENU_INSET = '8px';

/**
 * A CSS px length. Deliberately narrower than `string`: it is what every knob in this module
 * actually takes, and it rejects `menuSurfaceSx(theme, 'chartreuse')` at the type level.
 *
 * The constraint is chosen, not incidental - it also rejects `0`, `calc(...)` and rem values.
 * Every caller here passes px, so that costs nothing today; whoever first wants one of those
 * should widen this rather than cast around it.
 */
type PxLength = `${number}px`;

/**
 * The corner a menu surface uses unless a caller says otherwise, shared by menuSurfaceSx and
 * menuListSx so their defaults cannot drift into declaring different corners for one element.
 */
const MENU_SURFACE_RADIUS: PxLength = '8px';

/**
 * The corner of a row ON a menu surface, which is NOT the surface's own corner - a 12px panel
 * still wants 8px rows, and keeping the two separate is the point. Exported because a consumer
 * setting Joy's row variables itself (datalake/rowActionsMenu) needs the same value.
 */
export const MENU_ROW_RADIUS: PxLength = '8px';

/** The knobs the three list recipes share. */
type MenuListOpts = {
  /** Row spacing: 4px for a Select's listbox, 2px for the denser action menus. */
  gap?: PxLength;
  /** The surface's own corner - pass whatever menuSurfaceSx was given, so the two agree. */
  radius?: PxLength;
};

/**
 * Shared look for the app's floating menu surfaces (the profile menu, its "More" flyout, the
 * Data Lake row and lake menus, the chat panel's layout Select). One recipe so a tweak to the
 * ground or the lift reaches all of them. `radius` is the surface's own corner: the profile
 * panel and the Data Lake menus use 8px, the More flyout 12px.
 *
 * Anything on this ground that renders as a Joy List - a Menu, a Select listbox - wants
 * menuListSx too, and its rows want selectListboxSx (a Select) or menuItemListSx (a Menu). Pass
 * a non-default `radius` to BOTH: Joy paints the same element's corner from --List-radius, so the
 * two agree by construction only at the default (see menuListSx).
 */
export const menuSurfaceSx = (theme: Theme, radius: PxLength = MENU_SURFACE_RADIUS) => ({
  // Load-bearing on every popup, not a preference: Joy grounds a Select listbox and a Menu in
  // background.popup, which this theme never sets, so it falls through to Joy's own default -
  // common.white in light and, the trap, common.black in DARK. A popup that skips this recipe is
  // a pure black panel on an app whose surfaces never go fully black.
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
 * their row corners. It stays MENU_ROW_RADIUS whatever the surface's corner is: a 12px panel
 * still wants 8px rows.
 *
 * --List-radius is NOT merely that derivation's input. Joy paints a visible corner from it on
 * every surface these recipes land on - Menu.js:51 and Select.js:240 are both
 * `borderRadius: var(--List-radius, radius.sm)`, and List.js:130 the same on a bare List
 * (@mui/joy 5.0.0-beta.52). menuSurfaceSx wins that corner today only because its sx class
 * outranks Joy's styled class, so `radius` is threaded through here to stop the two declaring
 * different corners for one element.
 *
 * `gap` is 4px for a Select's listbox, 2px for the denser action menus. The padding is
 * MENU_INSET, the same constant menuSurfaceSx pads with, so the two stay equal by construction.
 */
export const menuListSx = ({ gap = '4px', radius = MENU_SURFACE_RADIUS }: MenuListOpts = {}) => ({
  '--List-padding': MENU_INSET,
  '--List-radius': radius,
  '--List-gap': gap,
  '--ListItem-radius': MENU_ROW_RADIUS,
  ...scrollbarStyles,
});

/**
 * A Select's listbox on a menuSurfaceSx ground: menuListSx plus the app's row scale and ink and
 * the option rows' hover, selected and focus states, so every Select in the app marks a row the
 * same way. A caller owns only what is genuinely its own - the popper placement and offsets, and a
 * minWidth where the anchor is narrower than the list wants to be.
 *
 * Joy paints an Option's hover, its keyboard-highlighted row and its press from
 * --variant-plain*Bg, so pointing those variables at the colour is what wins - a bare `&:hover`
 * rule loses to Joy's own. The selected ground cannot go the same way, for exactly the reason
 * menuItemListSx cannot either: Joy paints the selected row from the plainActive variant as well
 * (ListItemButton.js:99), so pointing that variable at the hover ground would leave a selected
 * row sitting on it. It is a declaration instead, and it lands because the descendant selector -
 * not the fact that it is a declaration - outranks Joy's own rule on the row's class.
 *
 * That rule DOES reach an Option, which is easy to get wrong from the source: `selected` is MUI's
 * global `Mui-selected` state class, so optionClasses.selected and listItemButtonClasses.selected
 * are the same string and ListItemButton's rule is not scoped away from Option.
 *
 * Joy's AutocompleteOption additionally paints `[aria-selected="true"]` directly
 * (AutocompleteOption.js:34) where Option leans on `.Mui-selected` alone - the divergence to know
 * about if an upgrade ever brings the two in line.
 *
 * Scoped to [role="option"], so spreading it on a Joy Menu is inert - Menu rows are
 * role="menuitem" and take menuItemListSx, or menuRowSx per item where a row wants the fixed
 * icon + label geometry (and the danger variant) too.
 *
 * The model-filter, file-browser, upload and research-model dropdowns each used to hand-roll a
 * borderless `background.body` variant of this, and it turned out not to be a second surface:
 * dark mode gives background.body and background.surface the same value, Joy's listbox slot has no
 * border for their `border: none` to remove (variant styles never reach it - Select.js:217, and
 * passing the slot a `variant` does not change that), and what they were really doing was
 * overriding the same black popup ground menuSurfaceSx overrides. Put a Select on this recipe
 * rather than re-deriving that.
 *
 * The app's other Select listboxes are a separate open set, not exceptions to this one: most set
 * only a maxHeight and so still take Joy's popup ground, and Credits/AccountSelector grounds
 * itself from its own palette token.
 */
export const selectListboxSx = (theme: Theme, opts?: MenuListOpts) => ({
  ...menuListSx(opts),
  // Joy's List paints itself with `body-${size}` typography (List.js:115), so a default-size
  // Select's listbox comes out at fontSize.md while every dropdown control in this app is a 14px
  // one. Pinned here so a caller does not have to size the listbox slot apart from its trigger,
  // and it reaches the rows on its own: an Option's own fontSize is `inherit`
  // (ListItemButton.js:86).
  fontSize: theme.fontSize.sm,
  '& [role="option"]': {
    // No borderRadius here: an Option is a StyledListItemButton, whose own
    // `borderRadius: var(--ListItem-radius)` (ListItemButton.js:83) already takes the corner
    // menuListSx pins above.
    transition: 'background 0.15s',
    // Joy paints EVERY row's ink from --variant-plainColor, which falls through to its own
    // un-themed neutral scale (neutral.700 in light) - this theme tints text.primary and leaves
    // `neutral` at Joy's defaults, so a row left to Joy reads grey among brand-tinted siblings.
    // Declaring it on the row also covers the SELECTED row, which Joy otherwise repaints from
    // --variant-outlinedColor: one ink throughout, so the weight below is what marks the row.
    color: theme.palette.text.primary,
    '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
    '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
    '&[aria-selected="true"]': {
      backgroundColor: theme.palette.notebooklist.focusedBackground,
      // The weight is load-bearing, not decoration, for the reason menuItemListSx spells out: in
      // dark mode notebooklist.hoverBg and focusedBackground are the SAME value, so a hovered
      // sibling paints the selected row's exact ground and the ground alone marks nothing.
      fontWeight: 600,
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.palette.primary[500]}`,
      outlineOffset: '-2px',
    },
  },
});

/**
 * The [role="menuitem"] mirror of selectListboxSx: a Joy Menu's rows on a menuSurfaceSx ground.
 * selectListboxSx is inert on these - Menu rows are menuitem, not option - which is how menus
 * sitting on the same ground ended up marking their rows differently.
 *
 * Sets no geometry on purpose, so it tolerates rows that are not menuRowSx's single 40px
 * icon + label line: the lake picker's are two-line, with a decorator and a trailing count.
 *
 * Hover and press go through Joy's variables because Joy's own ListItemButton rules outrank a
 * bare `&:hover` here. The selected row cannot: Joy paints `.Mui-selected` from the plainActive
 * variant as well, so pointing that variable at the hover ground would erase the selected marker.
 * It is a declaration instead, and it lands because the descendant selector - not the fact that it
 * is a declaration - outranks Joy's own rule on the row's class.
 *
 * That same descendant selector means a per-item sx will NOT override what this sets short of
 * escalating its own specificity (`&&`, `!important`), so a menu with per-row grounds
 * (rowActionsMenu's destructive row) stays on menuRowSx per item instead. Joy gives a ListItem
 * inside a Menu role="none", so a menu's non-row content (the lake picker's filter box, skeletons
 * and count chip) is untouched.
 *
 * These are custom properties: they inherit into the row's whole subtree, so a plain-variant Joy
 * child dropped into a row (an IconButton, a Chip) would pick the row's ground up as its own.
 * rowActionsMenu.tsx zeroes both variables on its trigger for exactly that reason.
 */
export const menuItemListSx = (theme: Theme, opts?: MenuListOpts) => ({
  ...menuListSx(opts),
  '& [role="menuitem"]': {
    transition: 'background 0.15s',
    '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
    '--variant-plainActiveBg': theme.palette.notebooklist.hoverBg,
    // The weight is load-bearing, not decoration: in dark mode notebooklist.hoverBg and
    // focusedBackground are the SAME value, so a hovered sibling paints the selected row's exact
    // ground and the ground alone stops marking anything. Joy's `body-sm` level declares no
    // fontWeight, so this inherits into a row's label Typography; `body-xs` declares one, which is
    // why a secondary line and a trailing count stay unbolded.
    [`&.${menuItemClasses.selected}`]: {
      backgroundColor: theme.palette.notebooklist.focusedBackground,
      fontWeight: 600,
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.palette.primary[500]}`,
      outlineOffset: '-2px',
    },
  },
});

/**
 * A single icon + label row inside a menuSurfaceSx panel. `danger` tints a destructive row.
 *
 * One ground covers hover and press, declared three ways because the consumers are not all the
 * same kind of element. The `&:hover` declaration is what the profile menu's plain Boxes use;
 * the two variables are what Joy reads on a MenuItem, whose own rules outrank that declaration.
 * --variant-plainActiveBg in particular has to be set: Joy's ListItemButton carries an
 * unconditional `&:active` painted from it, and left unset it falls through to
 * neutral.plainActiveBg, which this theme tints brand blue (themePrimitives.ts) - so the row
 * would flash blue under the finger instead of staying on its hover ground.
 */
export const menuRowSx = (theme: Theme, danger = false) => {
  const ground = danger ? theme.palette.danger.plainHoverBg : theme.palette.notebooklist.hoverBg;
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    px: '10px',
    height: '40px',
    borderRadius: MENU_ROW_RADIUS,
    cursor: 'pointer',
    color: danger ? theme.palette.danger[500] : theme.palette.sidenav?.navItemText,
    // Joy icons - and the Credits Bike4MindIcon, which fills with var(--Icon-color) - read
    // --Icon-color, not `color`. Tint them brand light-blue @50% (text.tertiary).
    '--Icon-color': danger ? theme.palette.danger[500] : theme.palette.text.tertiary,
    transition: 'background 0.15s',
    '&:hover': { backgroundColor: ground },
    '--variant-plainHoverBg': ground,
    '--variant-plainActiveBg': ground,
    '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
  };
};

/** Fixed box the row's icon sits in, so labels align regardless of glyph width. */
export const MENU_ROW_ICON_SX = {
  width: 22,
  height: 22,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
} as const;
