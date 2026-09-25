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
     * The fill a card's veil sits on. Same value as `surface` here, but its own
     * token because the two answer different questions: this one is "what colour is
     * a card", `surface` is "what colour is a code panel". Light needs them to
     * differ and dark does not, so they can only share a name by accident.
     */
    cardBase: gray[850],
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
    /**
     * The code surface. White, so code sits on paper: the card around it carries the
     * blue veil and the code panel carries none, which is the reverse of dark, where
     * the panel is the darker well and the card the lifted thing.
     *
     * Deliberately NOT mirroring dark's recess here. A light code panel has nothing
     * to gain from being duller than the card it sits in - grey under grey was what
     * read as dirty - and white buys the best contrast the syntax palette can get:
     * the weakest ink clears AA at 4.99 against 4.54 on gray[8].
     */
    surface: gray[0],
    /** Inline chips and table row hover: the veil baked flat. */
    surface2: '#EEF3F9',
    /**
     * White, so the veil over it is a clean tint rather than a mix. Every grey in
     * this ramp is faintly blue (gray[50] is C 1.46 at hue 244), and a blue veil on
     * an already-blue grey compounds into something muddy - which is what the card
     * used to look like. gray[0] is C 0.01, so the only colour on the card is the
     * one the veil puts there.
     *
     * A light card cannot copy dark's other trick. Dark lifts its card +4.64 L*
     * ABOVE the page; here the page is already L 98.9, so there is nowhere to lift
     * to. The card reads instead through its tint and its edge.
     */
    cardBase: gray[0],
    // Graded from the top, the same arrangement as dark: the blue gathers at the
    // head of the card and falls away. Over the old grey base that fall read as a
    // smudge, because a blue veil DARKENS a near-white fill; over white the same
    // stops read as a tint, which is what makes the direction work here at all.
    //
    // brand[800] rather than the brand[500] dark uses, so the veil and cardLine
    // below are one blue rather than two.
    //
    // The floor is 5%, not 2%: over white, 2% lands dE 0.36 from the page, which is
    // the page. The card used to fade out rather than grade, and that missing lower
    // end is what made the top look abrupt - the fall between the stops is the same
    // 1.5 L* either way.
    cardTintTop: brandAlpha[800][8],
    cardTintBottom: brandAlpha[800][5],
    // brand[800] rather than brand[500]: the mid blue is too pale to read as an
    // edge on a near-white card. 20% matches dark's edge-to-card separation.
    cardLine: brandAlpha[800][20],
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
