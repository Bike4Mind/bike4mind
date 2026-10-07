/**
 * Tools that ask in EVERY mode, including 'full'.
 *
 * These are gated on cost, not on filesystem risk, and the two are separate axes on purpose:
 * a user who has decided the agent may edit their files and run their build has said nothing
 * about spending credits on image generation or on starting an autonomous session.
 *
 * `session_send` is deliberately NOT here, though the turn it starts does cost credits. The
 * cycle it could run away with is already bounded in code - MAX_MESSAGE_HOPS on the chain and
 * MAX_SENDS_PER_TURN on the fan, so a user turn caps out at 14 relayed turns whatever the
 * agents do - and a per-send click on top of that bound only stops the autonomy the feature
 * exists for: a session that has finished its work sits waiting for a human purely to hand its
 * summary back. It rides the approval mode like any other tool instead, so 'ask' still asks
 * about every message and 'auto'/'full' let the chain run inside its structural bound.
 */
const SPENDS_CREDITS: ReadonlySet<string> = new Set([
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'session_spawn',
]);

export function spendsCredits(toolName: string): boolean {
  return SPENDS_CREDITS.has(toolName);
}
