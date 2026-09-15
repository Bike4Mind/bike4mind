/**
 * Colors for rendered reply markdown - the "reading" surface.
 *
 * These are the single source of truth for the tokens `markdown/observatory.css`
 * consumes: that stylesheet reads them as `--joy-palette-reading-*`, the CSS
 * variables Joy emits for every palette group, rather than carrying hexes of its
 * own. Adjust a reply color here, not in the stylesheet.
 *
 * The ramp is deliberately its own thing rather than a reuse of `gray`/`brand`:
 * it is a reading treatment with three ink steps (emphasis, prose, recessive)
 * whose relationships to each other matter more than their relationship to the
 * app's chrome.
 */
import { brand, brandAlpha } from '../colors';

export const readingTheme = {
  dark: {
    // Frames read by DEPTH against the page (#0E1214), which is what separates
    // them from the user's prompt bubble: the bubble is raised (background.panel,
    // 1.054:1 above the page) and everything a reply frames is a well below it.
    // Erik's mockup gets the same separation the other way round because his page
    // ground is far darker than ours; ported literally, his surfaces landed at
    // 1.000:1 here and vanished.
    /** Page ground, and the lighter strip in a two-tone code frame. */
    bg: '#0E1214',
    bg2: '#0B0F11',
    // Framed content lifts off the page and leans cool. Separation from the
    // prompt bubble is carried by hue, not depth: the bubble is a near-neutral
    // lift (b* -3.6) and these are markedly bluer at a similar lightness.
    //
    // Judge these in CIE Lab, never by contrast ratio - a luminance ratio reads
    // ~1.0:1 for two colours that differ only in hue, which is how Erik's card
    // fill looks identical to our page by that metric and dE 6.1 apart in fact.
    /**
     * Card base. Deliberately the same fill as the user's prompt bubble
     * (background.panel): a framed reply block is built as that fill plus the
     * blue veil below, so the two surfaces are visibly the same family and the
     * tint alone says which is which.
     */
    surface: '#13181C',
    /** Inline chips and table row hover: the veil baked flat, too small to grade. */
    surface2: '#141B23',
    /**
     * The veil, top and bottom of a card, as a gradient over `surface`. Brand
     * blue at 5% and 2% - a 3% flat veil already lands on Erik's card
     * relationship (dE 6.2 from the page against his 6.1), so anything past
     * single digits reads as a blue box rather than a tinted one.
     */
    cardTintTop: 'rgba(59, 130, 246, 0.05)',
    cardTintBottom: 'rgba(59, 130, 246, 0.02)',
    /** Card edge: the same brand blue, carried up to where a hairline reads. */
    cardLine: 'rgba(59, 130, 246, 0.18)',
    // One hairline for every framed thing, reply or prompt: these are the same
    // values as border.soft / border.light, so a reply frame and the prompt
    // bubble are edged identically.
    line: brandAlpha[100][8],
    line2: brandAlpha[100][15],
    // The three ink steps are one colour at three opacities - the app's own
    // text.primary - rather than a separate grey ramp, so a reply is written in
    // the same ink as the rest of the interface. Over the dark page they land at
    // 14.5:1, 10.6:1 and 7.5:1, which is the same spread the treatment was drawn
    // with. They composite against whatever is behind them, so a token used on a
    // filled surface (a table head, a code block) sits slightly lighter there
    // than on the open page - intended, and why these are alphas not hexes.
    /** Emphasis: strong, h1-h4, numeric cells. */
    ink: brand[100],
    /** Body prose - the step most of a reply is set in. */
    ink2: brandAlpha[100][85],
    /** Recessive: h5/h6, table heads, footnotes, blockquote, list markers. */
    ink3: brandAlpha[100][70],
    accent: '#5aaaea',
    accentSoft: 'rgba(90, 170, 234, 0.11)',
    accentLine: 'rgba(90, 170, 234, 0.34)',
    warn: '#e8a33d',
    warnSoft: 'rgba(232, 163, 61, 0.1)',
    danger: '#e5555a',
    ok: '#43d08c',
    /**
     * Top-edge highlight for framed cards, laid over the surface as a gradient
     * that fades out by mid-height. Brand-tinted rather than white so the lift
     * stays in the same cool family as the fill under it.
     */
    lift: brandAlpha[100][4],
  },
  light: {
    bg: '#eceff3',
    bg2: '#ffffff',
    surface: '#f6f9fb',
    surface2: '#edf2f6',
    // Light mode is not tuned yet; the veil is present so the token set matches
    // dark, at an alpha low enough to be a no-op until it is.
    cardTintTop: 'rgba(59, 130, 246, 0.04)',
    cardTintBottom: 'rgba(59, 130, 246, 0.015)',
    cardLine: 'rgba(11, 107, 203, 0.16)',
    line: 'rgba(16, 38, 56, 0.11)',
    line2: 'rgba(16, 38, 56, 0.22)',
    ink: '#141f28',
    ink2: '#364a58',
    ink3: '#506271',
    accent: '#0b6bcb',
    accentSoft: 'rgba(11, 107, 203, 0.07)',
    accentLine: 'rgba(11, 107, 203, 0.32)',
    warn: '#9a6410',
    warnSoft: 'rgba(232, 163, 61, 0.14)',
    danger: '#c41c1c',
    ok: '#167230',
    lift: 'rgba(255, 255, 255, 0.9)',
  },
};
