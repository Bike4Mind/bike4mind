import { questRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import {
  creditsForElapsed,
  MAX_SESSION_SECONDS,
  REALTIME_VOICE_HOLD_SECONDS,
  realtimeCreditsFloor,
} from './voiceSessionLimits';

const logger = new Logger({ metadata: { service: 'settleVoiceHold' } });

export type VoiceHold = {
  id: string;
  userId: string;
  voiceReservedCredits: number;
  voiceSessionStartedAt: Date;
};

export type VoiceHoldSettlement = { settled: false } | { settled: true; owed: number; refund: number };

/**
 * Call time a hold nobody closed can be shown to have used: from its start to the session's last
 * turn within the longest call's window, so a call that never produced a turn costs nothing. Turns
 * past the window are never call time: the user kept using the session after the call died.
 */
export async function evidencedVoiceCallSeconds(hold: VoiceHold, realtime: boolean): Promise<number> {
  const turns = await questRepository.findAllBySessionIdAndGreaterThanOrEqualToTimestamp(
    hold.id,
    hold.voiceSessionStartedAt
  );
  const startedAtMs = hold.voiceSessionStartedAt.getTime();
  const windowEndMs = startedAtMs + (realtime ? REALTIME_VOICE_HOLD_SECONDS : MAX_SESSION_SECONDS) * 1000;
  const lastTurnAtMs = turns.reduce((latest, turn) => {
    const turnAtMs = new Date(turn.timestamp).getTime();
    return turnAtMs <= windowEndMs && turnAtMs > latest ? turnAtMs : latest;
  }, 0);
  if (!lastTurnAtMs) return 0;
  return Math.floor((lastTurnAtMs - startedAtMs) / 1000);
}

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
      const restored = await sessionRepository
        .restoreVoiceHold(hold.id, hold.voiceReservedCredits, hold.voiceSessionStartedAt, billedCredits)
        .catch(restoreError => {
          throw new AggregateError(
            [creditError, restoreError],
            `voice hold ${hold.id}: refund failed and the hold could not be restored`
          );
        });
      // A newer call already holds the session, so no retry can settle this hold: the refund is
      // owed by hand.
      if (!restored) {
        logger.error('[settleVoiceHold] refund failed and a newer hold blocks restoring this one', {
          sessionId: hold.id,
          userId: hold.userId,
          startedAt: hold.voiceSessionStartedAt.toISOString(),
          refund,
        });
      }
      throw creditError;
    }
  }
  return { settled: true, owed, refund };
}

/**
 * Settle a session's open hold, if any, by the stale-hold sweep's rule. A fresh call writes its
 * new hold over the session's, so an earlier call that never closed (a closed tab sends no end
 * request or closing frame) must be settled first or its reservation is lost.
 */
export async function settlePriorVoiceHold(session: {
  id: string;
  userId: string;
  voiceReservedCredits?: number | null;
  voiceSessionStartedAt?: Date | null;
  voiceBilledCredits?: number | null;
}): Promise<VoiceHoldSettlement> {
  if (session.voiceReservedCredits == null || session.voiceSessionStartedAt == null) return { settled: false };
  const hold: VoiceHold = {
    id: session.id,
    userId: session.userId,
    voiceReservedCredits: session.voiceReservedCredits,
    voiceSessionStartedAt: session.voiceSessionStartedAt,
  };
  return settleVoiceHold(hold, await evidencedVoiceCallSeconds(hold, session.voiceBilledCredits != null));
}
