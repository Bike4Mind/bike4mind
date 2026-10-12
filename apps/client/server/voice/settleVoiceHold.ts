import { sessionRepository, userRepository } from '@bike4mind/database';
import { creditsForElapsed } from './voiceSessionLimits';

export type VoiceHold = {
  id: string;
  userId: string;
  voiceReservedCredits: number;
  voiceSessionStartedAt: Date;
  /** Restored with the hold if the refund fails, so a retry can still verify provider usage. */
  voiceProviderConversationIds?: string[];
};

export type VoiceHoldSettlement =
  | { settled: false; reason: 'already-settled' | 'conversation-added' }
  | { settled: true; owed: number; refund: number };

/**
 * Settle a voice credit hold: keep `elapsedSeconds` of call time (capped at the hold) and refund
 * the rest. The one settlement rule shared by POST /api/v1/voice/sessions/{id}/end and the stale
 * hold sweep (apps/workers/src/cron/voiceHoldSweep.ts). The hold is claimed atomically before any
 * credit moves, so of concurrent settlers exactly one refunds; the others get `settled: false`
 * with reason 'already-settled'. A settler whose measured ids a reconnect has since added to gets
 * 'conversation-added' instead: the hold stays live and the next end or sweep measures it again.
 * The caller supplies `elapsedSeconds`, measured by measureVoiceCallSeconds (./measureVoiceCall.ts).
 *
 * If crediting back throws, the hold is restored and the error rethrown, so the sweep retries it
 * rather than leaving the user charged the full reservation with no record left to reconcile.
 */
export async function settleVoiceHold(hold: VoiceHold, elapsedSeconds: number): Promise<VoiceHoldSettlement> {
  const claimed = await sessionRepository.claimVoiceHold(
    hold.id,
    hold.voiceSessionStartedAt,
    hold.voiceProviderConversationIds
  );
  if (!claimed) {
    if (!hold.voiceProviderConversationIds) return { settled: false, reason: 'already-settled' };
    const current = await sessionRepository.findByIdAndUserId(hold.id, hold.userId, { includeDeleted: true });
    const stillLive =
      !!current &&
      (current.voiceReservedCredits ?? 0) > 0 &&
      !!current.voiceSessionStartedAt &&
      new Date(current.voiceSessionStartedAt).getTime() === hold.voiceSessionStartedAt.getTime();
    return { settled: false, reason: stillLive ? 'conversation-added' : 'already-settled' };
  }

  const owed = creditsForElapsed(hold.voiceReservedCredits, elapsedSeconds);
  const refund = Math.max(0, hold.voiceReservedCredits - owed);
  // Claimed before crediting back so a concurrent settler can't double-refund.
  if (refund > 0) {
    try {
      await userRepository.incrementCredits(hold.userId, refund);
    } catch (creditError) {
      await sessionRepository
        .restoreVoiceHold(
          hold.id,
          hold.voiceReservedCredits,
          hold.voiceSessionStartedAt,
          hold.voiceProviderConversationIds ?? []
        )
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
