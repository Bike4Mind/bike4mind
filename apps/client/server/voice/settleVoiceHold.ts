import { sessionRepository, userRepository } from '@bike4mind/database';
import { creditsForElapsed, realtimeCreditsFloor } from './voiceSessionLimits';

export type VoiceHold = {
  id: string;
  userId: string;
  voiceReservedCredits: number;
  voiceSessionStartedAt: Date;
};

export type VoiceHoldSettlement = { settled: false } | { settled: true; owed: number; refund: number };

/**
 * Settle a voice credit hold: keep `elapsedSeconds` of call time (capped at the hold) and refund
 * the rest. The one settlement rule shared by POST /api/v1/voice/sessions/{id}/end and the stale
 * hold sweep (apps/workers/src/cron/voiceHoldSweep.ts). The hold is claimed atomically before any
 * credit moves, so of concurrent settlers exactly one refunds; the others get `settled: false`.
 * The caller supplies `elapsedSeconds`: the end endpoint measures wall clock, the sweep measures
 * the last turn the session evidences. A realtime hold (billed per response by
 * server/websocket/voiceSessionEnded.ts) keeps at least what its responses drew from it, and
 * prices call time at the realtime hold's own rate, the same floor its closing frame settles at.
 *
 * If crediting back throws, the hold is restored and the error rethrown, so the sweep retries it
 * rather than leaving the user charged the full reservation with no record left to reconcile.
 */
export async function settleVoiceHold(hold: VoiceHold, elapsedSeconds: number): Promise<VoiceHoldSettlement> {
  const claimed = await sessionRepository.claimVoiceHold(hold.id, hold.voiceSessionStartedAt);
  if (!claimed) return { settled: false };

  const { billedCredits } = claimed;
  const owed =
    billedCredits === null
      ? creditsForElapsed(hold.voiceReservedCredits, elapsedSeconds)
      : Math.max(
          Math.min(billedCredits, hold.voiceReservedCredits),
          realtimeCreditsFloor(hold.voiceReservedCredits, elapsedSeconds)
        );
  const refund = Math.max(0, hold.voiceReservedCredits - owed);
  // Claimed before crediting back so a concurrent settler can't double-refund.
  if (refund > 0) {
    try {
      await userRepository.incrementCredits(hold.userId, refund);
    } catch (creditError) {
      await sessionRepository
        .restoreVoiceHold(hold.id, hold.voiceReservedCredits, hold.voiceSessionStartedAt, billedCredits)
        .catch(restoreError => {
          throw new AggregateError(
            [creditError, restoreError],
            `voice hold ${hold.id}: refund failed and the hold could not be restored`
          );
        });
      throw creditError;
    }
  }
  return { settled: true, owed, refund };
}
