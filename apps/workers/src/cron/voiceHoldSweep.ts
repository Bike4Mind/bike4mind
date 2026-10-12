/**
 * Settles voice credit holds no client ever ended: a closed tab, a crashed browser, or a failed
 * connect on a client that never called the end endpoint. Without it such a hold keeps the whole
 * up-front reservation and the session keeps counting against the concurrent-call cap.
 *
 * Bills connected time up to the call's last sign of life (voiceLastActivityAt: client heartbeats
 * and provider turns), capped at the hold; a call that never connected costs nothing. A realtime
 * hold instead pays the open-time floor up to the last frame the server saw. Settles
 * through settleVoiceHold, the same claim-then-refund rule as the end endpoint, so a concurrent
 * end and a second sweep run are both no-ops. Every settlement writes one voice_hold_settled line.
 *
 * Schedule: rate(5 minutes).
 */
import { connectDB, sessionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { settleVoiceHold } from '@server/voice/settleVoiceHold';
import { MAX_SESSION_SECONDS } from '@server/voice/voiceSessionLimits';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'voiceHoldSweep' } });

// Past the longest call plus the session token's own headroom, so a live call is never swept.
export const VOICE_HOLD_STALE_AFTER_MS = (MAX_SESSION_SECONDS + 10 * 60) * 1000;
// Per-run cap; a backlog drains over successive runs, oldest first.
export const VOICE_HOLD_SWEEP_LIMIT = 200;

export interface VoiceHoldSweepResult {
  candidates: number;
  settled: number;
  refundedCredits: number;
  alreadySettled: number;
  failed: number;
}

export async function runVoiceHoldSweep(now: Date = new Date()): Promise<VoiceHoldSweepResult> {
  const startedBefore = new Date(now.getTime() - VOICE_HOLD_STALE_AFTER_MS);
  const holds = await sessionRepository.findStaleVoiceHolds(startedBefore, VOICE_HOLD_SWEEP_LIMIT);
  const result: VoiceHoldSweepResult = {
    candidates: holds.length,
    settled: 0,
    refundedCredits: 0,
    alreadySettled: 0,
    failed: 0,
  };

  for (const hold of holds) {
    try {
      const lastSeenAt = hold.voiceLastActivityAt ?? hold.voiceConnectedAt ?? hold.voiceSessionStartedAt;
      const settlement = await settleVoiceHold(
        hold,
        hold.voiceBillingMode === 'realtime'
          ? // An open realtime hold was never settled by a usage frame, so nothing was reported:
            // it pays the open-time floor up to the last frame the server saw.
            { kind: 'realtime', reportedCredits: 0, openUntil: lastSeenAt }
          : // A connected call with no later sign of life is billed nothing past its connect.
            { kind: 'connected-time', endedAt: lastSeenAt },
        'sweep'
      );
      if (!settlement.settled) {
        result.alreadySettled++;
        continue;
      }
      result.settled++;
      result.refundedCredits += settlement.refundedCredits;
    } catch (err) {
      result.failed++;
      logger.error('[voiceHoldSweep] failed to settle voice hold', { sessionId: hold.id, err });
    }
  }

  logger.info('[voiceHoldSweep] sweep complete', { ...result, capped: holds.length === VOICE_HOLD_SWEEP_LIMIT });
  return result;
}

export async function handler(): Promise<VoiceHoldSweepResult> {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runVoiceHoldSweep();
}
