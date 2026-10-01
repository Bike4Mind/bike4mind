/**
 * Tools that ask in EVERY mode, including 'full'.
 *
 * These are gated on cost, not on filesystem risk, and the two are separate axes on purpose:
 * a user who has decided the agent may edit their files and run their build has said nothing
 * about spending credits on image generation or on starting an autonomous session.
 *
 * `session_send` is here for the same reason `session_spawn` is, and it is the half of the
 * cycle bound the user holds: every message the agent sends to another conversation is asked
 * about, in every mode, keyed on the target and the text - so a ping-pong cannot run past the
 * first exchange without somebody clicking through each hop of it.
 */
const SPENDS_CREDITS: ReadonlySet<string> = new Set([
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'session_spawn',
  'session_send',
]);

export function spendsCredits(toolName: string): boolean {
  return SPENDS_CREDITS.has(toolName);
}
