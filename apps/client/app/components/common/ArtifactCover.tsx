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

/** Hues are picked off a fixed wheel rather than the full 360 so every cover keeps the app's
 *  register - no acid yellows or muddy olives - while still being clearly distinct. */
const HUE_STEPS = 12;
const HUE_OFFSET = 205; // start at the app's blue and walk around from there

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
  const h = hash32(publicId);
  const hue = (HUE_OFFSET + (h % HUE_STEPS) * (360 / HUE_STEPS)) % 360;
  // Second hue is a near-neighbour, so the gradient reads as one considered swatch rather than
  // two unrelated colours meeting in the middle.
  const hue2 = (hue + 24) % 360;
  // Angle varies too, so two artifacts that happen to share a hue bucket still differ.
  const angle = 20 + ((h >> 8) % 8) * 20;
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
        // Saturation and lightness are fixed; only hue and angle vary. That is what keeps a
        // library of covers looking like a set rather than a colour test card.
        background: `linear-gradient(${angle}deg, hsl(${hue} 42% 34%), hsl(${hue2} 38% 22%))`,
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
