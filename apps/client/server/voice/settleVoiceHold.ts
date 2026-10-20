import { CreditHolderType } from '@bike4mind/common';
import { creditTransactionRepository, sessionRepository, userRepository, withTransaction } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { creditsForElapsed, realtimeCreditsFloor } from '@bike4mind/server-utils/voice/voiceSessionLimits';

const logger = new Logger({ metadata: { service: 'voiceHoldSettlement' } });

/** Message of the one log line every settlement writes; aggregate on it. */
export const VOICE_HOLD_SETTLED_LOG = 'voice_hold_settled';

/**
 * Options for every voice balance transaction: the committed ledger row is what makes a repeat a
 * no-op, so it must not be readable before it is durable. Same as server/billing/grantCreditPurchase.ts.
 */
export const VOICE_TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
} as const;

/** The same options plus this module's logger, so withTransaction reports a retry and its exhaustion. */
const VOICE_SETTLE_TRANSACTION_OPTIONS = { ...VOICE_TRANSACTION_OPTIONS, logger };

/** Thrown inside a voice transaction whose ledger key already exists, so it aborts with nothing moved. */
export class VoiceLedgerKeyTaken extends Error {
  constructor(transactionId: string) {
    super(`voice ledger row ${transactionId} already exists`);
    this.name = 'VoiceLedgerKeyTaken';
  }
}

/** Whether `err` means the transaction's ledger key was already committed by an earlier attempt. */
export function isVoiceLedgerKeyTaken(err: unknown): boolean {
  if (err instanceof VoiceLedgerKeyTaken) return true;
  const dup = err as { code?: number; keyPattern?: Record<string, number> } | null;
  return dup?.code === 11000 && dup.keyPattern?.transactionId === 1;
}

/**
 * Write a voice usage ledger row inside the caller's transaction. A duplicate `transactionId`
 * throws VoiceLedgerKeyTaken: the server has already aborted the transaction, so it cannot commit.
 */
export async function recordVoiceUsage(row: {
  userId: string;
  sessionId: string;
  model: string;
  credits: number;
  transactionId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const recorded = await creditTransactionRepository.createTransaction('realtime_voice_usage', {
    ownerId: row.userId,
    ownerType: CreditHolderType.User,
    credits: -Math.abs(row.credits),
    description: 'Voice usage',
    model: row.model,
    sessionId: row.sessionId,
    transactionId: row.transactionId,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  });
  if (!recorded) throw new VoiceLedgerKeyTaken(row.transactionId);
}

/** Ledger key of a hold settlement: one per hold, which its session and start identify. */
export const voiceHoldSettleTransactionId = (sessionId: string, startedAt: Date) =>
  `voice-hold-settle:${sessionId}:${startedAt.toISOString()}`;

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
 * was open by the server's clock, up to `now` (capped at the hold's window): a realtime client
 * drives its own activity markers, so a silent one must not settle at its last frame for free.
 *
 * Refunds and the ledger row go to the user who paid the hold's reserve (voiceHoldUserId), falling
 * back to `hold.userId` for a hold opened before that was recorded.
 *
 * The claim, the refund and the ledger row commit in one transaction. The claim matches the hold's
 * start, so of concurrent or repeated settlers exactly one moves credits and the others get
 * `settled: false`; a failure leaves the hold open, unchanged, for the sweep to settle.
 */
export async function settleVoiceHold(
  hold: VoiceHold,
  endedAt: Date,
  source: VoiceHoldSettlementSource,
  now: Date = new Date()
): Promise<VoiceHoldSettlement> {
  const reserved = hold.voiceReservedCredits;
  let settlement: VoiceHoldSettlement;
  try {
    settlement = await withTransaction(async (): Promise<VoiceHoldSettlement> => {
      const claimed = await sessionRepository.claimVoiceHold(hold.id, hold.voiceSessionStartedAt);
      if (!claimed) return { settled: false };

      const { billedCredits } = claimed;
      const payerId = claimed.payerId ?? hold.userId;
      let chargedCredits: number;
      let connected: boolean;
      if (billedCredits !== null) {
        chargedCredits = Math.max(
          Math.min(billedCredits, reserved),
          realtimeCreditsFloor(reserved, secondsBetween(hold.voiceSessionStartedAt, now))
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
        await userRepository.incrementCredits(payerId, refundedCredits);
      }
      // Each realtime response wrote its own row, so only the charge they did not cover is new usage.
      const unrecorded = Math.max(0, chargedCredits - (billedCredits ?? 0));
      if (unrecorded > 0) {
        await recordVoiceUsage({
          userId: payerId,
          sessionId: hold.id,
          model: billedCredits !== null ? 'openai-realtime' : 'elevenlabs',
          credits: unrecorded,
          transactionId: voiceHoldSettleTransactionId(hold.id, hold.voiceSessionStartedAt),
        });
      }
      return { settled: true, connected, chargedCredits, refundedCredits };
    }, VOICE_SETTLE_TRANSACTION_OPTIONS);
  } catch (err) {
    if (isVoiceLedgerKeyTaken(err)) return { settled: false };
    throw err;
  }

  if (settlement.settled) {
    logger.info(VOICE_HOLD_SETTLED_LOG, {
      source,
      userId: hold.userId,
      sessionId: hold.id,
      holdCredits: reserved,
      chargedCredits: settlement.chargedCredits,
      refundedCredits: settlement.refundedCredits,
      connected: settlement.connected,
    });
  }
  return settlement;
}

/**
 * Open a fresh call's hold and take its reserve in one transaction, so neither lands without the
 * other. Resolves false, with nothing moved, when a concurrent bootstrap opened the session's hold
 * first. A null reserve (credits not enforced) opens the hold without touching the balance.
 *
 * The caller's balance pre-check reads the user before the provider call, so it can be stale by
 * now (another call's reserve, a chat debit). The reserve is therefore re-checked against the
 * balance inside the transaction: a reserve the balance no longer covers throws `unaffordable()`
 * and the transaction aborts with nothing moved.
 */
export async function reserveVoiceHold(args: {
  userId: string;
  sessionId: string;
  priorStartedAt: Date | null;
  reservedCredits: number | null;
  startedAt: Date;
  realtime: boolean;
  unaffordable: () => Error;
}): Promise<boolean> {
  return withTransaction(async () => {
    const opened = await sessionRepository.openVoiceHold(args.sessionId, args.priorStartedAt, {
      voiceReservedCredits: args.reservedCredits,
      voiceSessionStartedAt: args.startedAt,
      realtime: args.realtime,
      payerId: args.userId,
    });
    if (!opened) return false;
    if (args.reservedCredits) {
      const after = await userRepository.incrementCredits(args.userId, -args.reservedCredits);
      if ((after?.currentCredits ?? 0) < 0) throw args.unaffordable();
    }
    return true;
  }, VOICE_SETTLE_TRANSACTION_OPTIONS);
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
