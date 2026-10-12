/**
 * Settles voice credit holds no client ever ended: a closed tab, a crashed browser, or a failed
 * connect on a client that never called the end endpoint. Without it such a hold keeps the whole
 * up-front reservation and the session keeps counting against the concurrent-call cap.
 *
 * Keeps only the call time the session evidences - from the hold's start to its last turn within
 * the longest call's window, so a call that never produced a turn costs nothing - capped at the
 * hold. Turns past the window are never call time: the user kept using the session after the call
 * died, and counting them would keep the whole hold. Settles through
 * settleVoiceHold, the same claim-then-refund rule as POST /api/v1/voice/sessions/{id}/end, so a
 * concurrent end and a second sweep run are both no-ops. A realtime hold stays open for its whole
 * call, so it is only stale past the realtime hold's own window, and it keeps at least what its
 * responses already billed against it.
 *
 * Schedule: rate(5 minutes).
 */
import { connectDB, sessionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { evidencedVoiceCallSeconds, settleVoiceHold } from '@server/voice/settleVoiceHold';
import { MAX_SESSION_SECONDS, REALTIME_VOICE_HOLD_SECONDS } from '@server/voice/voiceSessionLimits';
import { Resource } from 'sst';

const logger = new Logger({ metadata: { service: 'voiceHoldSweep' } });

// Past the longest call plus the session token's own headroom, so a live call is never swept.
export const VOICE_HOLD_STALE_AFTER_MS = (MAX_SESSION_SECONDS + 10 * 60) * 1000;
// A realtime hold stays open for its whole call (it is billed per response), which may run this long.
export const REALTIME_VOICE_HOLD_STALE_AFTER_MS = (REALTIME_VOICE_HOLD_SECONDS + 10 * 60) * 1000;
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
  const realtimeStartedBefore = new Date(now.getTime() - REALTIME_VOICE_HOLD_STALE_AFTER_MS);
  const holds = await sessionRepository.findStaleVoiceHolds(
    startedBefore,
    realtimeStartedBefore,
    VOICE_HOLD_SWEEP_LIMIT
  );
  const result: VoiceHoldSweepResult = {
    candidates: holds.length,
    settled: 0,
    refundedCredits: 0,
    alreadySettled: 0,
    failed: 0,
  };

  for (const hold of holds) {
    try {
      const elapsedSeconds = await evidencedVoiceCallSeconds(hold, hold.realtime);
      const settlement = await settleVoiceHold(hold, elapsedSeconds);
      if (!settlement.settled) {
        result.alreadySettled++;
        continue;
      }
      result.settled++;
      result.refundedCredits += settlement.refund;
      logger.info('[voiceHoldSweep] settled stale voice hold', {
        sessionId: hold.id,
        userId: hold.userId,
        reserved: hold.voiceReservedCredits,
        elapsedSeconds,
        owed: settlement.owed,
        refund: settlement.refund,
      });
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
