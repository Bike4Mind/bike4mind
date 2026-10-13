import { sessionRepository, userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { creditsForElapsed, realtimeCreditsFloor } from './voiceSessionLimits';

const logger = new Logger({ metadata: { service: 'voiceHoldSettlement' } });

/** Message of the one log line every settlement writes; aggregate on it. */
export const VOICE_HOLD_SETTLED_LOG = 'voice_hold_settled';

export type VoiceHold = {
  id: string;
  userId: string;
  voiceReservedCredits: number;
  voiceSessionStartedAt: Date;
  voiceConnectedAt?: Date | null;
  voiceLastActivityAt?: Date | null;
};

export type VoiceHoldSettlementSource = 'end' | 'sweep' | 'bootstrap';

export type VoiceHoldSettlement =
  { settled: false } | { settled: true; connected: boolean; chargedCredits: number; refundedCredits: number };

const secondsBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

/**
 * Settle a voice credit hold for a call that ended at `endedAt`. The one settlement rule shared by
 * POST /api/v1/voice/sessions/{id}/end, the stale hold sweep (apps/workers/src/cron/voiceHoldSweep.ts)
 * and a fresh bootstrap over an open hold; the realtime closing frame
 * (server/websocket/voiceSessionEnded.ts) applies the same realtime rule inline.
 *
 * An ElevenLabs hold is billed connected time, from voiceConnectedAt to `endedAt`, capped at the
 * hold; a call that never connected costs nothing. A realtime hold (billed per response) keeps at
 * least what its responses drew from it and never less than the hold's own rate over the time it
 * was open by the server's clock. The hold is claimed atomically before any credit moves, so of
 * concurrent settlers exactly one settles and the others get `settled: false`.
 *
 * If crediting back throws, the hold is restored (with its per-call markers) and the error
 * rethrown, so the sweep retries it rather than leaving it with no record left to reconcile.
 */
export async function settleVoiceHold(
  hold: VoiceHold,
  endedAt: Date,
  source: VoiceHoldSettlementSource
): Promise<VoiceHoldSettlement> {
  const claimed = await sessionRepository.claimVoiceHold(hold.id, hold.voiceSessionStartedAt);
  if (!claimed) return { settled: false };

  const reserved = hold.voiceReservedCredits;
  const { billedCredits } = claimed;
  let chargedCredits: number;
  let connected: boolean;
  if (billedCredits !== null) {
    chargedCredits = Math.max(
      Math.min(billedCredits, reserved),
      realtimeCreditsFloor(reserved, secondsBetween(hold.voiceSessionStartedAt, endedAt))
    );
    connected = chargedCredits > 0;
  } else {
    connected = hold.voiceConnectedAt != null;
    chargedCredits = hold.voiceConnectedAt
      ? creditsForElapsed(reserved, secondsBetween(new Date(hold.voiceConnectedAt), endedAt))
      : 0;
  }

  // Responses billed past the hold already left the balance, so a settlement only ever refunds.
  const refundedCredits = Math.max(0, reserved - chargedCredits);
  if (refundedCredits > 0) {
    try {
      await userRepository.incrementCredits(hold.userId, refundedCredits);
    } catch (creditError) {
      const restored = await sessionRepository
        .restoreVoiceHold(hold.id, reserved, hold.voiceSessionStartedAt, {
          voiceConnectedAt: hold.voiceConnectedAt ?? null,
          voiceLastActivityAt: hold.voiceLastActivityAt ?? null,
          voiceBilledCredits: billedCredits,
        })
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
          refund: refundedCredits,
        });
      }
      throw creditError;
    }
  }

  logger.info(VOICE_HOLD_SETTLED_LOG, {
    source,
    userId: hold.userId,
    sessionId: hold.id,
    holdCredits: reserved,
    chargedCredits,
    refundedCredits,
    connected,
  });
  return { settled: true, connected, chargedCredits, refundedCredits };
}

/** When a call nobody closed was last seen alive: its last activity, else its connect, else its start. */
export function lastSeenAt(hold: VoiceHold): Date {
  return hold.voiceLastActivityAt ?? hold.voiceConnectedAt ?? hold.voiceSessionStartedAt;
}

/**
 * Settle a session's open hold, if any, up to when the call was last seen alive. A fresh call writes
 * its new hold over the session's, so an earlier call that never closed (a closed tab sends no end
 * request or closing frame) must be settled first or its reservation is lost.
 */
export async function settlePriorVoiceHold(session: {
  id: string;
  userId: string;
  voiceReservedCredits?: number | null;
  voiceSessionStartedAt?: Date | null;
  voiceConnectedAt?: Date | null;
  voiceLastActivityAt?: Date | null;
}): Promise<VoiceHoldSettlement> {
  if (session.voiceReservedCredits == null || session.voiceSessionStartedAt == null) return { settled: false };
  const hold: VoiceHold = {
    id: session.id,
    userId: session.userId,
    voiceReservedCredits: session.voiceReservedCredits,
    voiceSessionStartedAt: new Date(session.voiceSessionStartedAt),
    voiceConnectedAt: session.voiceConnectedAt ?? null,
    voiceLastActivityAt: session.voiceLastActivityAt ?? null,
  };
  return settleVoiceHold(hold, lastSeenAt(hold), 'bootstrap');
}
