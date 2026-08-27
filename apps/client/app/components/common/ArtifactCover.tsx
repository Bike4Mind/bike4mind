import React from 'react';
import { Box } from '@mui/joy';

/**
 * A deterministic generated cover for a published artifact.
 *
 * Chosen as the FLOOR of the thumbnail story rather than the whole of it: it costs nothing, needs
 * no publish-time pipeline, and - crucially - always exists, so no row and no card ever renders
 * an empty frame. Real screenshots are the ceiling and land later; when one exists for an
 * artifact it replaces this, and until then the grid still has visual rhythm.
 *
 * The point is RECOGNITION, not information. It cannot tell you what the artifact says, but it is
 * stable per artifact, so the same document is the same swatch every time you open the tab - which
 * is enough for the eye to find a row it has seen before. Derived from `publicId` (immutable for
 * the life of the artifact) rather than the title, so renaming does not change the cover and
 * break that recall.
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
 * whole point of a per-artifact cover - and this is easy to get wrong by reasoning about the hash
 * instead of the space. FNV-1a distributes well, and that is irrelevant if it is distributing into
 * too few buckets: at 12 hues x 8 angles = 96 combinations, forty artifacts collide on roughly eight
 * pairs (birthday), so the eye finds the wrong row.
 *
 * 24 hues x 3 saturations x 3 lightnesses x 8 angles reaches all 1,728 combinations, but NOT
 * uniformly, and the birthday sum is over the distribution rather than the count. The axes are not
 * independent: `h % 24` is not a bit range (24 = 8 x 3, so it shares `h mod 3` with the saturation
 * index). Enumerating the tuple over the whole uint32 range gives an effective space of 1,535
 * (1/sum of squared probabilities), which is 0.51 expected colliding pairs at forty artifacts and
 * crosses one pair around fifty-six. Ample, and worth stating as the real number rather than the
 * headline 1,728. Hues still come off a fixed wheel, and the saturation/lightness steps are narrow,
 * so covers remain a set rather than a colour test card.
 */
const HUE_STEPS = 24;
const HUE_OFFSET = 205; // start at the app's blue and walk around from there
const SATURATIONS = [34, 42, 50];
const LIGHTNESSES = [28, 34, 40];

/**
 * The cover's gradient for an artifact id. Exported and pure because the property that matters -
 * that two artifacts rarely look alike - is arithmetic over this string, and testing it through a
 * rendered element instead means testing jsdom's CSS parsing: Joy compiles `sx` to an emotion class,
 * so the node carries no inline background at all.
 */
export function coverGradient(publicId: string): string {
  const h = hash32(publicId);
  // A different slice of the hash per axis, so two ids in the same hue bucket are still unlikely to
  // share saturation, lightness and angle as well. (Hue reads the low end arithmetically rather
  // than as a bit range, which is why it is not fully independent of the others - see above.)
  //
  // UNSIGNED shifts throughout: hash32 returns the full uint32 range, and `>>` coerces to Int32, so
  // any hash with the top bit set shifted negative, `% 3` yielded 0/-1/-2, and SATURATIONS[-1] came
  // back undefined. One invalid colour stop invalidates the whole linear-gradient(), which
  // invalidates `background`, which the parser drops - so ~44% of ids rendered the empty frame this
  // component exists to prevent.
  const hue = (HUE_OFFSET + (h % HUE_STEPS) * (360 / HUE_STEPS)) % 360;
  const sat = SATURATIONS[(h >>> 5) % SATURATIONS.length];
  const light = LIGHTNESSES[(h >>> 11) % LIGHTNESSES.length];
  // Second hue is a near-neighbour, so the gradient reads as one considered swatch rather than two
  // unrelated colours meeting in the middle.
  const hue2 = (hue + 24) % 360;
  const angle = 20 + ((h >>> 17) % 8) * 20;
  return `linear-gradient(${angle}deg, hsl(${hue} ${sat}% ${light}%), hsl(${hue2} ${sat - 4}% ${light - 12}%))`;
}

export interface ArtifactCoverProps {
  /** Immutable artifact id. Title is deliberately NOT used - renaming must not change the cover. */
  publicId: string;
  /** Rendered size in px. Square by default; the list uses a small one, a grid a larger one. */
  size?: number;
  /** Shown as a single initial, purely as a secondary recognition cue. */
  title?: string;
  'data-testid'?: string;
}

export function ArtifactCover({ publicId, size = 28, title, ...rest }: ArtifactCoverProps) {
  const initial = title?.trim()?.[0]?.toUpperCase() ?? '';

  return (
    <Box
      aria-hidden="true"
      {...rest}
      sx={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 'sm',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: coverGradient(publicId),
        border: '1px solid',
        borderColor: 'divider',
        color: 'rgba(255,255,255,0.82)',
        fontSize: Math.max(10, Math.round(size * 0.42)),
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
