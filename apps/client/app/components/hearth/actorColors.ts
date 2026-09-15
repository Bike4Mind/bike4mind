import { useTheme } from '@mui/joy/styles';
import { actorColor } from '@bike4mind/hearth';

/**
 * Resolves an actorId to its palette color for the active theme mode. The
 * palette itself, and why it is only four hues, lives in @bike4mind/hearth so
 * the CLI renders the same identity for the same actor.
 *
 * Two of the light-mode slots sit below 3:1 against the surface, so this color
 * belongs on a MARK (a swatch, a rule) and never on the actor name - the name
 * stays in normal text ink and is what actually identifies the actor.
 */
export function useActorColor(): (actorId: string) => string {
  const theme = useTheme();
  // theme.palette.mode resolves 'system' to the real OS preference, which
  // useColorScheme does not.
  const shade = theme.palette.mode === 'dark' ? 'dark' : 'light';
  return (actorId: string) => actorColor(actorId)[shade];
}
