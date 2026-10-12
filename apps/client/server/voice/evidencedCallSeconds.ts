import { questRepository } from '@bike4mind/database';
import type { VoiceHold } from './settleVoiceHold';
import { MAX_SESSION_SECONDS } from './voiceSessionLimits';

/**
 * The call time a session's own turns evidence: from the hold's start to its last turn within the
 * longest call's window, so a call that never produced a turn costs nothing. Turns past the window
 * are never call time: the user kept using the session after the call died. The billing fallback
 * when the provider cannot measure a call (measureVoiceCall.ts, apps/workers voiceHoldSweep).
 */
export async function evidencedCallSeconds(hold: VoiceHold): Promise<number> {
  const turns = await questRepository.findAllBySessionIdAndGreaterThanOrEqualToTimestamp(
    hold.id,
    hold.voiceSessionStartedAt
  );
  const startedAtMs = hold.voiceSessionStartedAt.getTime();
  const windowEndMs = startedAtMs + MAX_SESSION_SECONDS * 1000;
  const lastTurnAtMs = turns.reduce((latest, turn) => {
    const turnAtMs = new Date(turn.timestamp).getTime();
    return turnAtMs <= windowEndMs && turnAtMs > latest ? turnAtMs : latest;
  }, 0);
  if (!lastTurnAtMs) return 0;
  return Math.floor((lastTurnAtMs - startedAtMs) / 1000);
}
