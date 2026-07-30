import { actorColorIndex } from '@bike4mind/hearth';

/**
 * Per-actor color for terminal output.
 *
 * The SLOT comes from @bike4mind/hearth so an actor lands on the same slot here
 * as in the SPA - that shared mapping is the point, since a session that reads
 * as teal in the web channel view and amber in the CLI is two identities to a
 * human, not one. Only the palette is local, because a terminal cannot express
 * the SPA's light/dark hex pairs and vice versa.
 *
 * 256-color foreground codes, chosen to stay legible on BOTH light and dark
 * terminal backgrounds (nothing near-black or near-white) and to remain
 * distinguishable under the common forms of color-vision deficiency - which is
 * also why the actor NAME is always printed alongside and color never carries
 * meaning on its own.
 */
// Must stay ACTOR_COLOR_SLOT_COUNT long: a shorter palette silently folds two
// slots onto one color and undoes the cross-surface guarantee above. Pinned by
// actorColors.test.ts rather than a module-level throw, which would take the
// whole CLI down on import over a cosmetic mismatch.
export const ACTOR_ANSI_COLORS = [
  '\x1b[38;5;33m', // blue
  '\x1b[38;5;35m', // green
  '\x1b[38;5;172m', // amber
  '\x1b[38;5;135m', // purple
  '\x1b[38;5;168m', // rose
  '\x1b[38;5;37m', // teal
] as const;

const RESET = '\x1b[0m';

/**
 * Whether to emit escape codes at all. Honors NO_COLOR (the de-facto standard)
 * and skips a non-TTY stdout so piped or redirected `/hearth` output stays
 * greppable instead of carrying escape sequences into a file.
 */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
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
