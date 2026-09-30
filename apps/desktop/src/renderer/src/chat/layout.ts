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
 * Centered reading column. Applied to the INNER element, so the scrollbar stays at the pane edge.
 *
 * The left edge of this element's CONTENT box is the column's content edge, and it is the one
 * line everything in the conversation aligns to - the line the transcript's prose sits on. Two
 * rules follow from that, and every row added to the column has to pick one:
 *
 *   - A control that draws a BORDER or a surface - a Chip, a Textarea, a Sheet, an Alert - puts
 *     its BORDER on the edge. That is what a plain child of the column already does, so such a
 *     control needs nothing beyond being inside a `contentColumnSx` element. It must not spread
 *     `contentColumnSx` onto ITSELF: the column's `px` would become the surface's own padding
 *     and the surface would bleed a gutter's width past the column on both sides.
 *
 *   - A control with no border - an icon button, plain text - puts its visible GLYPH on the
 *     edge, which means cancelling the inset its own box puts around that glyph. See
 *     `columnStartGlyphSx`.
 *
 * A stack that scrolls one of these rows and not the others needs `columnStackSx` on the stack
 * and `scrollingColumnHostSx` on the row that scrolls, or that row's scrollbar shifts its column
 * off the line the rest are on.
 */
export const contentColumnSx: SxProps = {
  width: '100%',
  maxWidth: CONTENT_MAX_WIDTH,
  mx: 'auto',
  px: 3,
};

/**
 * Width of a classic scrollbar, published as a CSS variable on the document root.
 *
 * CSS has no way to read it and the column needs it: the transcript scrolls and the rows under
 * it do not, so a scrollbar taken out of the transcript's width alone leaves its column centred
 * in a narrower box than theirs - half a scrollbar to the left of the line they are on. It is an
 * OS setting, so it is measured once. Zero wherever scrollbars overlay the content, which is
 * macOS unless the user asked for them permanently, and then none of this does anything.
 */
export const SCROLL_GUTTER_VAR = '--b4m-scroll-gutter';

/** Measures the scrollbar and publishes it as `SCROLL_GUTTER_VAR`. Call once, before first paint. */
export function publishScrollGutterWidth(doc: Document = document): void {
  const probe = doc.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll';
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
 */
export const scrollingColumnHostSx: SxProps = {
  overflowY: 'auto',
  scrollbarGutter: 'stable',
  marginRight: `calc(-1 * var(${SCROLL_GUTTER_VAR}, 0px))`,
};

/**
 * Breathing room a borderless control keeps around its glyph, in px.
 *
 * Joy centres an IconButton's glyph inside a 32px box, so how far in from the border the glyph
 * lands depends on the glyph - 6px for a 20px icon, ~10px for a '+' set at body-lg. Pinning the
 * padding instead makes that inset a constant, which is what lets `columnStartGlyphSx` cancel it
 * exactly rather than by a number measured once against one glyph and wrong for the next.
 */
export const GLYPH_INSET = 8;

/**
 * A borderless control that STARTS a row in the column: its glyph lands on the content edge.
 *
 * Read with `GLYPH_INSET`: the padding is set, then the same amount is taken back off the
 * margin, so what is left over the edge is the glyph itself. The hit area and the hover surface
 * stay centred on the glyph, which a left-aligned box inside a fixed-width button would not.
 */
export const columnStartGlyphSx: SxProps = {
  minWidth: 0,
  paddingInline: `${GLYPH_INSET}px`,
  ml: `-${GLYPH_INSET}px`,
};
