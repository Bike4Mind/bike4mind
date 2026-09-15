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
import { alpha } from '@mui/system';
import { blue, brand, brandAlpha, gray, orange } from '../colors';

export const readingTheme = {
  dark: {
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
    surface: gray[850],
    /** Inline chips and table row hover: the veil baked flat, too small to grade. */
    surface2: '#141B23',
    /**
     * The veil, top and bottom of a card, as a gradient over `surface`. Brand
     * blue at 5% and 2% - a 3% flat veil already lands on Erik's card
     * relationship (dE 6.2 from the page against his 6.1), so anything past
     * single digits reads as a blue box rather than a tinted one.
     */
    cardTintTop: alpha(brand[500], 0.05),
    cardTintBottom: alpha(brand[500], 0.02),
    /** Card edge: the same brand blue, carried up to where a hairline reads. */
    cardLine: alpha(brand[500], 0.18),
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
    accent: blue[550],
    accentSoft: alpha(blue[550], 0.11),
    accentLine: alpha(blue[550], 0.34),
    warnSoft: alpha(orange[425], 0.1),
  },
  light: {
    surface: '#f6f9fb',
    surface2: '#edf2f6',
    // Light mode is not tuned yet; the veil is present so the token set matches
    // dark, at an alpha low enough to be a no-op until it is.
    cardTintTop: alpha(brand[500], 0.04),
    cardTintBottom: alpha(brand[500], 0.015),
    cardLine: alpha(brand[800], 0.16),
    line: 'rgba(16, 38, 56, 0.11)',
    line2: 'rgba(16, 38, 56, 0.22)',
    // Same construction as dark - one ink at three opacities - but tinted from a
    // deep navy rather than the pale one, because light needs a dark base: our
    // own text.primary here is brand[400], a mid-tone teal at 6.79:1, and every
    // tint of it falls below AA for body text.
    ink: brand[650],
    ink2: brandAlpha[650][85],
    ink3: brandAlpha[650][70],
    accent: brand[800],
    accentSoft: alpha(brand[800], 0.07),
    accentLine: alpha(brand[800], 0.32),
    warnSoft: alpha(orange[425], 0.14),
  },
};
