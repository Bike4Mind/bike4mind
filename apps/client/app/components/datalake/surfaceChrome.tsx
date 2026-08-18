/**
 * surfaceChrome - brand-agnostic visual primitives for the standalone Data Lake
 * surface (tree, article, explorer header).
 *
 * Nothing here may carry product flavor: hues are named after colors rather than
 * concepts and every string is caller-supplied. Branded surfaces layer their own
 * look on top by overriding the `theme` half of the surface tokens - see
 * `DataLakeSurfaceProvider` in `surfaceTokens.tsx`.
 *
 * `deckChrome.tsx` re-exports these primitives under its historical names so the
 * premium deck surfaces keep their import paths - it imports from here rather than
 * duplicating, so the palette and animations cannot drift between the two.
 */

import { Box, Typography } from '@mui/joy';
import { alpha, keyframes } from '@mui/system';

/** A single ink, with a bright variant for dark mode and a deep variant for light mode. */
export interface Hue {
  base: string;
  deep: string;
}

export const SURFACE_HUES = {
  cyan: { base: '#5CE1FF', deep: '#0277A8' },
  violet: { base: '#8B7CFF', deep: '#5B4BD6' },
  magenta: { base: '#FF6FD8', deep: '#B81E90' },
  amber: { base: '#FFC857', deep: '#A36F00' },
  emerald: { base: '#4ADE80', deep: '#15803D' },
  blue: { base: '#6FA8FF', deep: '#2563EB' },
  red: { base: '#FF7A6B', deep: '#C2271A' },
  slate: { base: '#9FB3C8', deep: '#52677D' },
} as const satisfies Record<string, Hue>;

/** Resolve a hue to readable ink for the current color scheme. */
export const inkFor = (hue: Hue, isDark: boolean) => (isDark ? hue.base : hue.deep);

export const REDUCED_MOTION_OFF = {
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
} as const;

/** Expanding ring, used by the article empty state's emitter. */
export const ringPing = keyframes`
  0% { transform: scale(0.3); opacity: 0.7; }
  100% { transform: scale(1); opacity: 0; }
`;

/** Slow ambient wander for decorative background motes. */
export const driftFloat = keyframes`
  0%, 100% { transform: translate(0, 0); }
  25% { transform: translate(6px, -10px); }
  50% { transform: translate(-4px, -16px); }
  75% { transform: translate(-8px, -6px); }
`;

export const cursorBlink = keyframes`
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0.15; }
`;

/** Ambient radial washes behind a surface, tinted by the caller's two lead hues. */
export const surfaceBackground = (isDark: boolean, accent: Hue, secondary: Hue) =>
  isDark
    ? `radial-gradient(ellipse 80% 45% at 50% -8%, ${alpha(accent.base, 0.1)}, transparent 65%),
       radial-gradient(ellipse 60% 40% at 88% 108%, ${alpha(secondary.base, 0.07)}, transparent 60%)`
    : `radial-gradient(ellipse 80% 45% at 50% -8%, ${alpha(accent.deep, 0.07)}, transparent 65%),
       radial-gradient(ellipse 60% 40% at 88% 108%, ${alpha(secondary.deep, 0.05)}, transparent 60%)`;

export interface TickerStat {
  label: string;
  value: string;
  sub?: string;
}

/** Compact monospace stat row for a surface header. */
export function StatTicker({
  stats,
  isDark,
  dotHue = SURFACE_HUES.emerald,
}: {
  stats: TickerStat[];
  isDark: boolean;
  dotHue?: Hue;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'wrap',
        columnGap: 3,
        rowGap: 0.5,
      }}
    >
      {stats.map(stat => (
        <Box key={stat.label} sx={{ display: 'flex', alignItems: 'baseline', gap: 0.6 }}>
          <Box
            sx={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              bgcolor: inkFor(dotHue, isDark),
              animation: `${cursorBlink} 2.4s steps(1) infinite`,
              ...REDUCED_MOTION_OFF,
            }}
          />
          <Typography
            level="body-xs"
            sx={{
              fontFamily: 'monospace',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'text.tertiary',
            }}
          >
            {stat.label}
          </Typography>
          <Typography level="body-xs" sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'text.primary' }}>
            {stat.value}
          </Typography>
          {stat.sub && (
            <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'text.tertiary' }}>
              {stat.sub}
            </Typography>
          )}
        </Box>
      ))}
    </Box>
  );
}
