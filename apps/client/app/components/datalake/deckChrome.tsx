/**
 * deckChrome - shared visual language for the OptiHashi "command deck" surfaces
 *
 * Houses the animated ion-trap hero field, section headers, the active-brief card,
 * and card glow helpers used by SalesCommandDeck, OptiHub, and any future
 * deck-styled mission surface.
 *
 * The brand-agnostic primitives (palette, `inkFor`, generic animations, the stat
 * ticker) live in `surfaceChrome.tsx` and are re-exported here under their
 * historical deck names - import, never copy, so the two cannot drift. The open
 * Data Lake surface reads them from `surfaceChrome`/`surfaceTokens` instead, so
 * nothing in this file is on its dependency path.
 */

import { Box, Card, Chip, Typography } from '@mui/joy';
import type { Theme } from '@mui/joy/styles';
import { alpha, keyframes } from '@mui/system';
import { compactButtonSx } from '@client/app/utils/buttonStyles';
import { memo, type ReactNode } from 'react';
import {
  SURFACE_HUES as HUES,
  dataChipSx,
  inkFor,
  surfaceBackground,
  REDUCED_MOTION_OFF,
  type Hue,
} from '@client/app/components/datalake/surfaceChrome';

export {
  SURFACE_HUES as HUES,
  inkFor,
  REDUCED_MOTION_OFF,
  cursorBlink,
  driftFloat,
  dataChipSx,
  /** Historical name for the generic expanding-ring animation. */
  ringPing as sonarPing,
  StatTicker as TelemetryTicker,
} from '@client/app/components/datalake/surfaceChrome';
export type { Hue, TickerStat } from '@client/app/components/datalake/surfaceChrome';

/** Map a Q/Work job status to a telemetry dot color + pulse flag. */
export function statusDot(status: string | undefined, isDark: boolean): { color: string; pulse: boolean } {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return { color: inkFor(HUES.emerald, isDark), pulse: false };
    case 'running':
    case 'pending':
    case 'queued':
    case 'submitting':
      return { color: inkFor(HUES.cyan, isDark), pulse: true };
    case 'failed':
    case 'error':
      return { color: inkFor(HUES.red, isDark), pulse: false };
    case 'cancelled':
      return { color: inkFor(HUES.amber, isDark), pulse: false };
    default:
      return { color: inkFor(HUES.slate, isDark), pulse: false };
  }
}

/** MUI Joy soft-chip color for a Q/Work job status (neutral fallback). Shared by the
 *  scheduling Mission Log and the family Q/Work runs list so the status palette can't drift. */
export function statusChipColor(status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' | 'primary' {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
    case 'succeeded':
      return 'success';
    case 'running':
    case 'submitting':
      return 'primary';
    case 'failed':
    case 'error':
      return 'danger';
    case 'cancelled':
      return 'warning';
    case 'pending':
    case 'queued':
    default:
      return 'neutral';
  }
}

/* Animations */

export const ionPulse = keyframes`
  0%, 100% { opacity: 0.75; box-shadow: 0 0 6px 1px var(--ion-glow); }
  50% { opacity: 1; box-shadow: 0 0 16px 4px var(--ion-glow); }
`;

export const arcFlow = keyframes`
  from { stroke-dashoffset: 24; }
  to { stroke-dashoffset: 0; }
`;

/** Deal-in flip for encounter cards - they land on the table like dealt cards. */
export const cardDeal = keyframes`
  0% { opacity: 0; transform: translateY(20px) rotate(-1.5deg) scale(0.97); }
  100% { opacity: 1; transform: translateY(0) rotate(0deg) scale(1); }
`;

/* Page background */

/** Ambient radial washes behind a deck surface (the deck's cyan/violet tint). */
export const deckBackground = (isDark: boolean) => surfaceBackground(isDark, HUES.cyan, HUES.violet);

/* Card glow */

/** Hover-glow sx for clickable deck cards. */
export const glowCardSx = (hue: Hue, isDark: boolean) => {
  const ink = inkFor(hue, isDark);
  return {
    cursor: 'pointer',
    borderColor: alpha(ink, isDark ? 0.45 : 0.4),
    backgroundColor: isDark ? alpha(hue.base, 0.05) : alpha(hue.deep, 0.04),
    transition: 'transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease',
    '&:hover': {
      transform: 'translateY(-3px)',
      borderColor: ink,
      boxShadow: `0 6px 24px -6px ${alpha(ink, isDark ? 0.45 : 0.3)}`,
    },
    '&:active': { transform: 'translateY(-1px)' },
  };
};

/* Ion trap hero */

const ION_POSITIONS = [12, 24.5, 37, 49.5, 62, 74.5, 87];
const ENTANGLE_ARCS: [number, number][] = [
  [0, 3],
  [2, 5],
  [1, 6],
  [3, 6],
];

export function IonTrapField({ isDark }: { isDark: boolean }) {
  const arcStroke = isDark ? alpha(HUES.cyan.base, 0.35) : alpha(HUES.cyan.deep, 0.3);
  const railColor = isDark ? alpha(HUES.slate.base, 0.25) : alpha(HUES.slate.deep, 0.25);
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {/* Trap electrode rails */}
      {['32%', '68%'].map(top => (
        <Box
          key={top}
          sx={{
            position: 'absolute',
            left: '6%',
            right: '6%',
            top,
            height: '1px',
            background: `linear-gradient(90deg, transparent, ${railColor} 18%, ${railColor} 82%, transparent)`,
          }}
        />
      ))}

      {/* Entanglement arcs */}
      <svg
        viewBox="0 0 100 36"
        preserveAspectRatio="none"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        {ENTANGLE_ARCS.map(([a, b], i) => {
          const x1 = ION_POSITIONS[a];
          const x2 = ION_POSITIONS[b];
          const mid = (x1 + x2) / 2;
          const lift = 18 - Math.abs(x2 - x1) * 0.22;
          return (
            <Box
              component="path"
              key={`${a}-${b}`}
              d={`M ${x1} 18 Q ${mid} ${Math.max(2, lift)} ${x2} 18`}
              sx={{
                fill: 'none',
                stroke: arcStroke,
                strokeWidth: 1,
                strokeDasharray: '3 5',
                vectorEffect: 'non-scaling-stroke',
                animation: `${arcFlow} ${2.2 + i * 0.7}s linear infinite`,
                ...REDUCED_MOTION_OFF,
              }}
            />
          );
        })}
      </svg>

      {/* Trapped ions */}
      {ION_POSITIONS.map((x, i) => {
        const hue = i % 3 === 1 ? HUES.violet : HUES.cyan;
        const glow = inkFor(hue, isDark);
        return (
          <Box
            key={x}
            sx={{
              position: 'absolute',
              left: `${x}%`,
              top: '50%',
              mt: '-4px',
              ml: '-4px',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: `radial-gradient(circle at 35% 35%, #FFFFFF, ${glow})`,
              '--ion-glow': alpha(glow, isDark ? 0.8 : 0.5),
              animation: `${ionPulse} ${2.6 + (i % 3) * 0.5}s ease-in-out ${i * 0.35}s infinite`,
              ...REDUCED_MOTION_OFF,
            }}
          />
        );
      })}
    </Box>
  );
}

/* Section header */

export function DeckSectionHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, mb: 1.5 }}>
      <Typography
        level="body-xs"
        sx={{
          fontWeight: 800,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'text.tertiary',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Typography>
      {/* ml auto rather than a stretching rule between the two: the hint still sits
          at the far edge, without an empty element drawing a line to it. */}
      {hint && (
        <Typography level="body-xs" sx={{ ml: 'auto', color: 'text.tertiary', whiteSpace: 'nowrap' }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

/* Console frame */

/**
 * A framed block on the /opti surfaces: hairline box on the panel ground. Shared
 * so blocks wear the same frame rather than each mixing its own.
 */
export const consolePanelSx = (theme: Theme) => ({
  borderRadius: '12px',
  border: '1px solid',
  borderColor: theme.palette.border.input,
  backgroundColor: theme.palette.background.surface2,
});

/* Active brief */

/**
 * The Active Brief card - hoisted above the sub-tabs (rendered once) so it stays
 * visible on every tab. Domain-free: callers pass the derived name, stats, and
 * objective line so scheduling and the eight families render the identical card.
 *
 * Memoized because it would otherwise re-render on every solver progress tick.
 * Callers must pass a stable `stats` array and `actions` node (useMemo).
 */
export const ActiveBriefCard = memo(function ActiveBriefCard({
  name,
  description,
  stats,
  objectiveLine,
  isDark,
  actions,
  fromChat = false,
}: {
  name: string;
  description?: string;
  stats: string[];
  objectiveLine: string;
  isDark: boolean;
  actions?: ReactNode;
  /** True when this brief is the one the AI chat last formulated (and hasn't been
   *  hand-edited since); surfaces a persistent "synced from chat" provenance chip. */
  fromChat?: boolean;
}) {
  return (
    // No frame, ground or inset of its own: the brief is the first thing in the
    // console column, and the panel around it already holds it. gap 0 because the
    // lines inside carry their own spacing, and Joy's card gap stacked on top of
    // that opened the block to twice the height of its content.
    <Card variant="plain" data-testid="opti-active-brief" sx={{ gap: 0, '--Card-padding': '12px' }}>
      {/* The surface's eyebrow: the label states what the block is, so it recedes
          into a caption rather than announcing itself in a hue. Unspaced and at
          reading size - tracked-out micro-caps read as decoration, not a word. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: '8px' }}>
        <Typography
          level="body-xs"
          sx={{
            fontFamily: 'monospace',
            fontSize: '12px',
            fontWeight: 600,
            textTransform: 'uppercase',
            color: 'text.tertiary',
          }}
        >
          Active Brief — now solving
        </Typography>
        {fromChat && (
          <Chip data-testid="opti-brief-from-chat" size="sm" variant="outlined" sx={dataChipSx(isDark)}>
            synced from chat
          </Chip>
        )}
      </Box>
      {/* Each line carries its own bottom margin: the card's own gap is off, so a
          line that does not render (no description) takes no space with it. */}
      <Typography level="title-lg" sx={{ mb: '16px' }}>
        {name}
      </Typography>
      {description && (
        <Typography level="body-sm" sx={{ color: 'text.secondary', mb: '16px' }}>
          {description}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: '24px' }}>
        {stats.map(stat => (
          <Chip key={stat} size="sm" variant="outlined" sx={dataChipSx(isDark)}>
            {stat}
          </Chip>
        ))}
        <Chip size="sm" variant="outlined" sx={dataChipSx(isDark)}>
          {objectiveLine}
        </Chip>
      </Box>
      {actions && (
        <Box
          sx={{
            display: 'flex',
            gap: '12px',
            flexWrap: 'wrap',
            // The card owns its footer metrics: whichever buttons a caller passes,
            // the row reads at one size instead of at each caller's own default.
            '& > button': compactButtonSx,
          }}
        >
          {actions}
        </Box>
      )}
    </Card>
  );
});
