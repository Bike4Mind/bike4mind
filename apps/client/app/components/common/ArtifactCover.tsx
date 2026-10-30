import React from 'react';
import { Box } from '@mui/joy';

/**
 * A deterministic generated cover for a published artifact: one muted solid color plus the title's
 * first letter.
 *
 * This is the FALLBACK of the thumbnail story, not the whole of it. When an artifact has a rendered
 * thumbnail, ArtifactThumbnail shows that instead; this covers every artifact that has none yet (and
 * any whose image fails to load). It costs nothing, needs no publish-time pipeline, and always
 * exists, so no row and no card ever renders an empty frame.
 *
 * The point is RECOGNITION, not information. It cannot tell you what the artifact says, but the
 * color is stable per artifact, so the same document is the same swatch every time you open the tab -
 * which is enough for the eye to find a row it has seen before. The color is derived from `publicId`
 * (immutable for the life of the artifact) rather than the title, so renaming does not change it
 * and break that recall. The letter is a secondary cue and does follow the title.
 */

/**
 * FNV-1a, 32-bit. A tiny non-cryptographic hash chosen because it distributes short similar
 * strings well - `pub_ab1` and `pub_ab2` land far apart, where a naive character sum would give
 * them near-identical hues and make sibling artifacts indistinguishable.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The output space has to be big enough that a library does not visibly repeat itself, which is the
 * whole point of a per-artifact color - and this is easy to get wrong by reasoning about the hash
 * instead of the space. FNV-1a distributes well, and that is irrelevant if it is distributing into
 * too few buckets.
 *
 * 36 hues x 3 saturations x 4 lightnesses = 432 swatches. The axes are not fully independent -
 * `h % 36` is not a bit range - and enumerating the tuple across the uint32 range gives an effective
 * space (1 / sum of squared probabilities) of about 419. That is ~0.7 expected colliding pairs on a
 * page of 25 artifacts and ~4 at sixty; the letter breaks most of those ties. The collision test
 * measures the observed rate rather than restating these constants.
 *
 * The lightness band is capped low on purpose: every swatch has to keep at least 4.5:1 contrast with
 * COVER_LETTER_COLOR, which is what makes one letter color work in light and dark mode alike. The
 * contrast test enforces it across every combination.
 */
const HUE_STEPS = 36;
const HUE_OFFSET = 205; // start at the app's blue and walk around from there
const SATURATIONS = [28, 36, 44];
const LIGHTNESSES = [18, 22, 26, 30];

/** Off-white, not pure white, so a large letter on a bright thumbnail grid does not glare. */
export const COVER_LETTER_COLOR = '#f5f6f7';

/**
 * The cover color for an artifact id. Exported and pure because the property that matters - that
 * two artifacts rarely look alike - is arithmetic over this string, and testing it through a
 * rendered element instead means testing jsdom's CSS parsing: Joy compiles `sx` to an emotion class,
 * so the node carries no inline background at all.
 */
export function coverColor(publicId: string): string {
  const h = hash32(publicId);
  // A different slice of the hash per axis, so two ids in the same hue bucket are still unlikely to
  // share saturation and lightness as well.
  //
  // UNSIGNED shifts throughout: hash32 returns the full uint32 range, and `>>` coerces to Int32, so
  // any hash with the top bit set shifted negative, `% 3` yielded 0/-1/-2, and SATURATIONS[-1] came
  // back undefined. An invalid color invalidates the whole `background` declaration, which the parser
  // drops - so roughly 44% of ids rendered the empty frame this component exists to prevent.
  const hue = (HUE_OFFSET + (h % HUE_STEPS) * (360 / HUE_STEPS)) % 360;
  const sat = SATURATIONS[(h >>> 5) % SATURATIONS.length];
  const light = LIGHTNESSES[(h >>> 11) % LIGHTNESSES.length];
  return `hsl(${hue} ${sat}% ${light}%)`;
}

export interface ArtifactCoverProps {
  /** Immutable artifact id. Title is deliberately NOT used for the color - renaming must not change it. */
  publicId: string;
  /** Square size in px, or 'fill' to take the parent's whole box (the parent clips the corners). */
  size?: number | 'fill';
  /** Shown as a single initial, purely as a secondary recognition cue. */
  title?: string;
  'data-testid'?: string;
}

/** Letter size for the fill variant: a card thumbnail is a few hundred px wide, so a fixed size reads
 *  as a deliberate monogram rather than scaling with the card. */
const FILL_LETTER_SIZE = 44;
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function ArtifactCover({ publicId, size = 28, title, ...rest }: ArtifactCoverProps) {
  const [firstCharacter] = titleSegmenter.segment(title?.trim() ?? '');
  const initial = firstCharacter?.segment.toUpperCase() ?? '';
  const fill = size === 'fill';

  return (
    <Box
      aria-hidden="true"
      {...rest}
      sx={{
        width: fill ? '100%' : size,
        height: fill ? '100%' : size,
        flex: 'none',
        borderRadius: fill ? 0 : 'sm',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: coverColor(publicId),
        border: fill ? 'none' : '1px solid',
        borderColor: 'divider',
        color: COVER_LETTER_COLOR,
        fontSize: fill ? FILL_LETTER_SIZE : Math.max(10, Math.round(size * 0.42)),
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      {initial}
    </Box>
  );
}

export default ArtifactCover;
