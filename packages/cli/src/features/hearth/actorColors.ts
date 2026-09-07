import { ACTOR_COLOR_SLOTS, actorColorIndex } from '@bike4mind/hearth';

/**
 * Per-actor color for terminal output.
 *
 * Both the SLOT and the hues come from @bike4mind/hearth so an actor lands on
 * the same color here as in the SPA - a session that reads as green in the web
 * channel view and amber in the CLI is two identities to a human, not one. Only
 * the ENCODING is local: the shared palette is light/dark hex pairs, which a
 * terminal cannot take directly.
 *
 * Truecolor rather than the 256-color cube so the emitted color is the validated
 * hue itself and not a nearest-neighbour approximation of it - the all-pairs
 * separation numbers in ACTOR_COLOR_SLOTS only hold for the exact steps. The
 * dark step is used because a terminal is assumed dark and there is no portable
 * way to ask it. Colour is never the only signal either way: the actor name and
 * the kind marker are always printed alongside.
 */
export const ACTOR_ANSI_COLORS: readonly string[] = ACTOR_COLOR_SLOTS.map(slot => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(slot.dark.slice(i, i + 2), 16));
  return `\x1b[38;2;${r};${g};${b}m`;
});

const RESET = '\x1b[0m';

/**
 * Whether to emit escape codes at all. Honors NO_COLOR (the de-facto standard)
 * and skips a non-TTY stdout so piped or redirected `/hearth` output stays
 * greppable instead of carrying escape sequences into a file.
 *
 * FORCE_COLOR='0' is the standard force-DISABLE signal and must be checked
 * before the truthiness test, since the string '0' is truthy in JS. This repo
 * relies on that convention (bashExecute sets FORCE_COLOR: '0'), so treating
 * any defined value as "on" would emit codes into captured tool output.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

/** Wrap text in the actor's stable color, or return it unchanged when color is off. */
export function colorizeActor(actorId: string, text: string): string {
  if (!colorEnabled()) return text;
  // Modulo guards the render path against a palette/slot-count mismatch: a wrong
  // color beats an undefined escape sequence corrupting the terminal.
  const color = ACTOR_ANSI_COLORS[actorColorIndex(actorId) % ACTOR_ANSI_COLORS.length];
  return `${color}${text}${RESET}`;
}
