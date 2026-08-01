import { useTheme } from '@mui/joy/styles';

/**
 * Per-actor colors: a FIXED palette, indexed by a hash of actorId. The hash is
 * what makes the color stable - index-in-array or arrival order would repaint
 * every actor whenever the tail changes or a reload reorders the buffer, and a
 * shifting color is worse than no color for telling two agents apart.
 *
 * Deliberately small and hand-picked per theme mode rather than generated hues:
 * unbounded HSL lands on colors that are unreadable on one surface or the other
 * and indistinguishable from their neighbors. Hash collisions are expected and
 * harmless because color is NEVER the only signal - the actor name and the kind
 * or state chip identify the actor on their own (this also keeps color from
 * being forgeable identity, per the actor-spoofing concern).
 *
 * Shared by the event stream and the presence roster so one actor reads as the
 * same identity in both.
 */
const ACTOR_COLORS: ReadonlyArray<{ light: string; dark: string }> = [
  { light: '#1d4ed8', dark: '#93c5fd' },
  { light: '#047857', dark: '#6ee7b7' },
  { light: '#b45309', dark: '#fcd34d' },
  { light: '#7e22ce', dark: '#d8b4fe' },
  { light: '#be123c', dark: '#fda4af' },
  { light: '#0e7490', dark: '#67e8f9' },
];

/** Used when a row carries no usable actorId - never a generated hue. */
const NEUTRAL_ACTOR_COLOR = { light: '#475569', dark: '#cbd5e1' };

/**
 * djb2 over the actorId, folded into the palette. Exported for the test that
 * pins determinism: the same actorId must always map to the same slot.
 */
export function actorColorIndex(actorId: string): number {
  let hash = 5381;
  for (let i = 0; i < actorId.length; i++) {
    hash = ((hash << 5) + hash + actorId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % ACTOR_COLORS.length;
}

/** Resolves an actorId to its palette color for the active theme mode. */
export function useActorColor(): (actorId: string) => string {
  const theme = useTheme();
  // theme.palette.mode resolves 'system' to the real OS preference, which
  // useColorScheme does not.
  const shade = theme.palette.mode === 'dark' ? 'dark' : 'light';
  return (actorId: string) => (actorId ? ACTOR_COLORS[actorColorIndex(actorId)] : NEUTRAL_ACTOR_COLOR)[shade];
}
