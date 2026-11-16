/**
 * Tools that spend credits beyond the chat turn itself. Not an approval gate: they ride the
 * approval mode like any other tool, as every chat turn spends credits too. The capability
 * ledger files their grants under 'credits'; see capabilityFor.
 */
const SPENDS_CREDITS: ReadonlySet<string> = new Set([
  'generate_image',
  'generate_speech',
  'generate_sound_effect',
  'generate_music',
  'generate_video',
  'session_spawn',
]);

export function spendsCredits(toolName: string): boolean {
  return SPENDS_CREDITS.has(toolName);
}
