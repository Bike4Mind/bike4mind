import { sessionRepository, userRepository } from '@bike4mind/database';
import type { VoiceBillingMode } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { usdToCredits } from '@bike4mind/utils';
import { creditsForElapsed, REALTIME_VOICE_RESERVE_USD, realtimeCreditsFloor } from './voiceSessionLimits';

const logger = new Logger({ metadata: { service: 'voiceHoldSettlement' } });

/** Message of the one log line every settlement writes; aggregate on it. */
export const VOICE_HOLD_SETTLED_LOG = 'voice_hold_settled';

export type VoiceHold = {
  id: string;
  userId: string;
  /** Null when credits were not enforced at call start. */
  voiceReservedCredits: number | null;
  voiceSessionStartedAt: Date;
  voiceConnectedAt?: Date | null;
  voiceLastActivityAt?: Date | null;
  voiceBillingMode?: VoiceBillingMode | null;
};

export type VoiceHoldCharge =
  // ElevenLabs calls: connected time, from the first connect to `endedAt`.
  | { kind: 'connected-time'; endedAt: Date }
  // OpenAI realtime calls: the client-reported usage, never less than the hold's own rate over the
  // time the call was open by the server's clock (hold start to `openUntil`).
  | { kind: 'realtime'; reportedCredits: number; openUntil: Date };

export type VoiceHoldSettlementSource = 'end' | 'sweep' | 'realtime-frame';

export type VoiceHoldSettlement =
  { settled: false } | { settled: true; connected: boolean; chargedCredits: number; refundedCredits: number };

const secondsBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));

function creditsOwed(hold: VoiceHold, charge: VoiceHoldCharge, reserved: number): number {
  if (charge.kind === 'realtime') {
    // Client usage can only raise the charge; the floor rests on server-observed time alone.
    const floorBase = hold.voiceReservedCredits ?? usdToCredits(REALTIME_VOICE_RESERVE_USD);
    const floor = realtimeCreditsFloor(floorBase, secondsBetween(hold.voiceSessionStartedAt, charge.openUntil));
    return Math.max(charge.reportedCredits, floor);
  }
  if (!hold.voiceConnectedAt) return 0;
  return creditsForElapsed(reserved, secondsBetween(new Date(hold.voiceConnectedAt), charge.endedAt));
}

/**
 * Settle a voice credit hold. The one settlement rule shared by POST
 * /api/v1/voice/sessions/{id}/end, the realtime settlement frame
 * (server/websocket/voiceSessionEnded.ts) and the stale hold sweep
 * (apps/workers/src/cron/voiceHoldSweep.ts).
 *
 * Connected time is billed from voiceConnectedAt to `endedAt`, capped at the hold; a call that never
 * connected costs nothing. Realtime usage is billed as reported, floored by open time, and may
 * exceed the hold. The hold is claimed atomically before any credit moves, so of concurrent
 * settlers exactly one settles and the others get `settled: false`.
 *
 * If moving the credits throws, the hold is restored (with its per-call markers) and the error
 * rethrown, so the sweep retries it rather than leaving it with no record left to reconcile.
 */
export async function settleVoiceHold(
  hold: VoiceHold,
  charge: VoiceHoldCharge,
  source: VoiceHoldSettlementSource
): Promise<VoiceHoldSettlement> {
  const claimed = await sessionRepository.claimVoiceHold(hold.id, hold.voiceSessionStartedAt);
  if (!claimed) return { settled: false };

  const reserved = hold.voiceReservedCredits ?? 0;
  const chargedCredits = creditsOwed(hold, charge, reserved);
  const connected = hold.voiceConnectedAt != null || (charge.kind === 'realtime' && chargedCredits > 0);

  // Positive refunds the unused hold; negative charges usage past it.
  const delta = reserved - chargedCredits;
  if (delta !== 0) {
    try {
      await userRepository.incrementCredits(hold.userId, delta);
    } catch (creditError) {
      await sessionRepository
        .restoreVoiceHold(hold.id, hold.voiceReservedCredits, hold.voiceSessionStartedAt, {
          voiceConnectedAt: hold.voiceConnectedAt ?? null,
          voiceLastActivityAt: hold.voiceLastActivityAt ?? null,
          voiceBillingMode: hold.voiceBillingMode ?? null,
        })
        .catch(restoreError => {
          throw new AggregateError(
            [creditError, restoreError],
            `voice hold ${hold.id}: settlement failed and the hold could not be restored`
          );
        });
      throw creditError;
    }
  }

  const refundedCredits = Math.max(0, delta);
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
