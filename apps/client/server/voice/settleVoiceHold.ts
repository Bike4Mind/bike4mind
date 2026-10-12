import { sessionRepository, userRepository } from '@bike4mind/database';
import { creditsForElapsed } from './voiceSessionLimits';

export interface VoiceHold {
  id: string;
  userId: string;
  voiceReservedCredits: number;
  voiceSessionStartedAt: Date;
}

export type VoiceHoldSettlement = { settled: false } | { settled: true; owed: number; refund: number };

/**
 * Settle a voice credit hold: keep `elapsedSeconds` of call time (capped at the hold) and refund
 * the rest. The one settlement rule shared by POST /api/v1/voice/sessions/{id}/end and the stale
 * hold sweep (apps/workers/src/cron/voiceHoldSweep.ts). The hold is claimed atomically before any
 * credit moves, so of concurrent settlers exactly one refunds; the others get `settled: false`.
 */
export async function settleVoiceHold(hold: VoiceHold, elapsedSeconds: number): Promise<VoiceHoldSettlement> {
  const claimed = await sessionRepository.claimVoiceHold(hold.id, hold.voiceSessionStartedAt);
  if (!claimed) return { settled: false };

  const owed = creditsForElapsed(hold.voiceReservedCredits, elapsedSeconds);
  const refund = Math.max(0, hold.voiceReservedCredits - owed);
  // Claimed before crediting back: a refund lost to a transient failure here is preferable to
  // issuing free credits.
  if (refund > 0) {
    await userRepository.incrementCredits(hold.userId, refund);
  }
  return { settled: true, owed, refund };
}
