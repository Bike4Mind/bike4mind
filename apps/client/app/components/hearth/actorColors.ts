import { useTheme } from '@mui/joy/styles';
import { actorColorIndex } from '@bike4mind/hearth';

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

// The slot mapping is NOT local: it lives in @bike4mind/hearth so this view,
// the presence roster, and the CLI `/hearth` output all land an actor on the
// same slot. A session that reads as teal here and amber in the CLI is two
// identities to a human, not one. Only the palette stays local, because a
// terminal cannot express these light/dark hex pairs.
export { actorColorIndex };

/** Resolves an actorId to its palette color for the active theme mode. */
export function useActorColor(): (actorId: string) => string {
  const theme = useTheme();
  // theme.palette.mode resolves 'system' to the real OS preference, which
  // useColorScheme does not.
  const shade = theme.palette.mode === 'dark' ? 'dark' : 'light';
  return (actorId: string) => (actorId ? ACTOR_COLORS[actorColorIndex(actorId)] : NEUTRAL_ACTOR_COLOR)[shade];
}
