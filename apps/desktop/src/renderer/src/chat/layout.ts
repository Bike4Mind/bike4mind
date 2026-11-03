import type { SxProps } from '@mui/joy/styles/types';

/**
 * Reading width for the conversation, in px.
 *
 * A line of prose stops being comfortable to read somewhere past ~90 characters, and on a
 * maximised window the thread would otherwise run the full width of the display. The thread,
 * the composer and the header all share this so they stay in one visual column.
 */
export const CONTENT_MAX_WIDTH = 760;

/**
 * The chat window's root: exactly the viewport, never scrolled as a whole. `clip` rather than
 * `hidden`, which is still a scroll container that a `scrollIntoView` could shift with no scrollbar.
 */
export const chatShellRootSx: SxProps = {
  position: 'relative',
  display: 'flex',
  height: '100vh',
  overflow: 'clip',
  bgcolor: 'background.body',
};

/** contentColumnSx's horizontal padding, in theme spacing units (`px: 3`). */
const COLUMN_PADDING_UNITS = 3;
/** The same padding in px (Joy's spacing unit is 8px), for code that measures against the column. */
export const COLUMN_PADDING = COLUMN_PADDING_UNITS * 8;

/**
 * Centered reading column. Applied to the INNER element, so the scrollbar stays at the pane edge.
 *
 * The left edge of this element's CONTENT box is the column's content edge, and it is the one
 * line everything in the conversation aligns to - the line the transcript's prose sits on. One
 * rule covers every row: a control puts its own OUTER edge on that line, and whatever the
 * control draws inside itself is inset by its own padding.
 *
 * Outer edge means the hard edge the eye reads - the border of a Chip, a Textarea, a Sheet or an
 * Alert, and equally the surface an otherwise plain control fills in when it is hovered or
 * pressed. An IconButton is the case that keeps being got wrong: it looks borderless at rest, so
 * pulling it left until the glyph itself sat on the line seemed right, but then its hover
 * surface was the thing hanging outside the column. Its box goes on the line like everything
 * else, and the glyph rides ~10px inside it - the same way a placeholder sits inside an input's
 * border and a label inside a chip's.
 *
 * A control therefore needs NOTHING beyond being a child of a `contentColumnSx` element. What it
 * must not do is spread `contentColumnSx` onto ITSELF: the column's `px` would become the
 * control's own padding and its surface would bleed a gutter's width past the column both sides.
 *
 * A stack that scrolls one of these rows and not the others needs `columnStackSx` on the stack
 * and `scrollingColumnHostSx` on the row that scrolls, or that row's scrollbar shifts its column
 * off the line the rest are on.
 */
export const contentColumnSx: SxProps = {
  width: '100%',
  maxWidth: CONTENT_MAX_WIDTH,
  mx: 'auto',
  px: COLUMN_PADDING_UNITS,
};

/**
 * Geometry, in px, of the slim bars above the composer: ChangesBar and the PrStatusBar that
 * replaces it once a PR exists. Shared so neither the leading icon nor the composer moves when
 * one bar swaps for the other.
 */
export const COMPOSER_BAR_HEIGHT = 32;
export const COMPOSER_BAR_BORDER = 1;
// A bar's controls sit this far inside its border on top, bottom and the far end, and its side
// padding matches, so every edge has the same gap.
export const COMPOSER_BAR_INSET = 4;

const COMPOSER_BAR_CONTROL_HEIGHT = COMPOSER_BAR_HEIGHT - 2 * (COMPOSER_BAR_BORDER + COMPOSER_BAR_INSET);

const composerBarControlBaseSx = {
  // Radius shrinks by the distance between the two edges, so the corners nest inside the bar's.
  borderRadius: `calc(var(--joy-radius-md) - ${COMPOSER_BAR_BORDER + COMPOSER_BAR_INSET}px)`,
  // Joy's default 2px offset would put the 2px focus ring on the bar's border.
  '--focus-outline-offset': '0px',
} as const;

/** A labelled Button or MenuButton inside a composer bar. */
export const composerBarControlSx = {
  ...composerBarControlBaseSx,
  height: COMPOSER_BAR_CONTROL_HEIGHT,
  minHeight: COMPOSER_BAR_CONTROL_HEIGHT,
  py: 0,
  fontWeight: 'md',
  whiteSpace: 'nowrap',
  '--Button-gap': '6px',
} as const;

/** An IconButton inside a composer bar; wider than tall so the short button is still easy to hit. */
export const composerBarIconButtonSx = {
  ...composerBarControlBaseSx,
  '--IconButton-size': `${COMPOSER_BAR_CONTROL_HEIGHT}px`,
  minWidth: 28,
} as const;

/**
 * The thin scrollbar the sidebar, the transcript and the scrollers in and beside it share.
 *
 * The shape lives in scrollbars.css, loaded before the gutter is measured. Keep the standard
 * properties at auto so Chromium uses those pseudo-elements instead of its native boxed bar.
 */
export const thinScrollbarSx = {
  scrollbarWidth: 'auto',
  scrollbarColor: 'auto',
} as const;

/**
 * No scrollbar at all, for a strip that scrolls sideways but has no room for one: the browser's
 * tab row, where a bar would push the tabs off the url bar they sit on. Wheel and trackpad still
 * scroll it.
 */
export const hiddenScrollbarSx = {
  scrollbarWidth: 'none',
} as const;

/**
 * Width of a `thinScrollbarSx` scrollbar, published as a CSS variable on the document root.
 *
 * CSS has no way to read it and the column needs it: the transcript scrolls and the rows under
 * it do not, so a scrollbar taken out of the transcript's width alone leaves its column centred
 * in a narrower box than theirs - half a scrollbar to the left of the line they are on. It is a
 * renderer setting, so it is measured once. Zero wherever scrollbars overlay the content, and then
 * none of this does anything.
 */
export const SCROLL_GUTTER_VAR = '--b4m-scroll-gutter';

/** Measures the scrollbar and publishes it as `SCROLL_GUTTER_VAR`. Call once, before first paint. */
export function publishScrollGutterWidth(doc: Document = document): void {
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll';
  Object.assign(probe.style, thinScrollbarSx);
  doc.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  doc.documentElement.style.setProperty(SCROLL_GUTTER_VAR, `${width}px`);
}

/**
 * A stack of column rows, one of which scrolls: the gutter is reserved for ALL of them.
 *
 * Pairs with `scrollingColumnHostSx`, which spends it. Reserving here rather than on each row is
 * what keeps `contentColumnSx` the only thing a new row has to know about.
 */
export const columnStackSx: SxProps = {
  paddingRight: `var(${SCROLL_GUTTER_VAR}, 0px)`,
};

/**
 * The one row inside a `columnStackSx` that scrolls.
 *
 * It reaches back out over the gutter its parent reserved, so the scrollbar is drawn at the pane
 * edge rather than a scrollbar's width inside it - and what is left for the column is then the
 * same width the rows that do not scroll were given. `stable` because that has to hold whether
 * or not there is anything to scroll: an `auto` scrollbar coming and going with the length of
 * the conversation would take the column with it.
 *
 * Positioned because an overflow box clips only descendants whose containing block it contains;
 * an absolute box resolving past it would lengthen the document instead.
 */
export const scrollingColumnHostSx: SxProps = {
  position: 'relative',
  overflowY: 'auto',
  scrollbarGutter: 'stable',
  ...thinScrollbarSx,
  marginRight: `calc(-1 * var(${SCROLL_GUTTER_VAR}, 0px))`,
};
