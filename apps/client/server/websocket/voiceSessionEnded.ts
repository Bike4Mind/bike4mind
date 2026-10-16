import { withWebSocketContext, sendToClient } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { pickRealtimeVoiceTier } from '@server/voice/realtimeVoicePricing';
import {
  ApiKeyScope,
  CreditHolderType,
  IModelPrice,
  VoiceSessionEndedAction,
  computeRealtimeVoiceUsd,
} from '@bike4mind/common';
import {
  getSettingsMap,
  getSettingsValue,
  NotFoundError,
  usdToCredits,
  usdToCreditsStochastic,
} from '@bike4mind/utils';
import {
  adminSettingsRepository,
  Connection,
  modelPriceRepository,
  sessionRepository,
  usageEventRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { connectionHoldsScope } from '@server/websocket/connectionScope';
import { REALTIME_VOICE_RESERVE_USD, realtimeCreditsFloor } from '@server/voice/voiceSessionLimits';
import { isVoiceLedgerKeyTaken, recordVoiceUsage, VOICE_TRANSACTION_OPTIONS } from '@server/voice/settleVoiceHold';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const { userId, sessionId, model, usage, responseId } = VoiceSessionEndedAction.parse(JSON.parse(event.body ?? ''));

  // Verify the claimed userId matches the authenticated connection owner.
  // withWebSocketContext does not inject the authenticated user - the connectionId
  // is the server-authoritative identity source stored at connect time.
  const connectionId = event.requestContext.connectionId;
  const connection = await Connection.findOne({ connectionId });
  if (!connection || connection.userId !== userId) {
    logger.warn('voiceSessionEnded userId mismatch or unknown connection - rejecting', {
      connectionId,
      claimedUserId: userId,
    });
    return { statusCode: 200 };
  }

  // This frame settles credits. Owning the socket is not enough authority for that: a key minted
  // only to run the cc-bridge can open one, and must not be able to move its owner's balance.
  if (!connectionHoldsScope(connection, [ApiKeyScope.AI_CHAT])) {
    logger.warn('voiceSessionEnded from a connection without ai:chat scope - rejecting', {
      connectionId,
      claimedUserId: userId,
    });
    return { statusCode: 200 };
  }

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  const session = await sessionService.getSession(
    user.id,
    { id: sessionId },
    {
      db: {
        sessions: sessionRepository,
        users: userRepository,
      },
    }
  );
  if (!session) {
    logger.warn(`Session not found for sessionId ${sessionId}`);
    return { statusCode: 200 };
  }
  // getSession also admits users the notebook is shared with, but only the owner can open a hold
  // (pages/api/ai/voice-sessions) and pay for it: anyone else's close would refund it to them.
  if (session.userId !== user.id) {
    logger.warn(`voiceSessionEnded: user ${user.id} does not own session ${sessionId} - rejecting`);
    return { statusCode: 200 };
  }

  // Rates come from the versioned price catalog (reprices reach voice as data
  // rows); the adapter literal is the fail-safe when the catalog is unreachable.
  let priceRows: IModelPrice[] = [];
  try {
    priceRows = await modelPriceRepository.rowsInForce();
  } catch (err) {
    logger.warn('Model price catalog unavailable; settling voice from fallback rates', err);
  }
  const { tier } = pickRealtimeVoiceTier(model, priceRows);
  const totalUsd = computeRealtimeVoiceUsd(tier, usage);
  // Single stochastic draw per settlement (pricing.ts policy); the old
  // per-component ceil overcharged up to ~6 credits per session.
  let actualCredits: number = usdToCreditsStochastic(totalUsd);
  // Credits still reserved for this call after this frame: an open hold is not exhaustion.
  let holdLeft = 0;

  // Both transactions below carry the request logger, so withTransaction reports a retry and its exhaustion.
  const transactionOptions = { ...VOICE_TRANSACTION_OPTIONS, logger };

  if (responseId) {
    // One response of a live call. Its ledger row, the hold's billed total and the debit commit
    // together, keyed on the response, so a replayed frame moves nothing. The hold stays open, so
    // later responses and a reconnect (which reuses a live hold) keep drawing on it.
    const startedAt = session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt) : null;
    const reserved = session.voiceReservedCredits ?? 0;
    let billedBefore: number | null;
    try {
      billedBefore = await withTransaction(async () => {
        await recordVoiceUsage({
          userId: user.id,
          sessionId,
          model,
          credits: actualCredits,
          transactionId: `realtime-voice:${sessionId}:${responseId}`,
        });
        const before = startedAt
          ? await sessionRepository.addVoiceBilledCredits(session.id, startedAt, actualCredits)
          : null;
        // Only the part past the hold leaves the balance now; the hold already covers the rest. With
        // the hold already closed (a close frame that overtook this one) the whole response is charged.
        const fromBalance =
          before === null
            ? actualCredits
            : Math.max(0, before + actualCredits - reserved) - Math.max(0, before - reserved);
        if (fromBalance > 0) {
          await userRepository.incrementCredits(user.id, -fromBalance);
        }
        return before;
      }, transactionOptions);
    } catch (err) {
      if (!isVoiceLedgerKeyTaken(err)) throw err;
      logger.warn(`voiceSessionEnded: response ${responseId} on session ${sessionId} already billed - ignoring`);
      return { statusCode: 200 };
    }
    if (billedBefore !== null) {
      holdLeft = Math.max(0, reserved - billedBefore - actualCredits);
    }
    // The sweep settles an abandoned hold up to the last response the server saw. Best-effort and
    // after the debit, so a failed marker write can never leave a ledger row the balance never paid.
    await sessionRepository.recordVoiceActivity(session.id, new Date(), startedAt).catch(err => {
      logger.warn('voiceSessionEnded: failed to record voice activity', { sessionId, err });
    });
  } else {
    // The call is over: bill this frame's usage and refund what the hold did not cover. Older
    // clients send exactly one of these per call, so this is also their whole settlement.
    if (!session.voiceSessionStartedAt) {
      logger.warn(`voiceSessionEnded: session ${sessionId} has no active voice session - ignoring (possible replay)`);
      return { statusCode: 200 };
    }
    const startedAt = new Date(session.voiceSessionStartedAt);
    const reserved = session.voiceReservedCredits ?? 0;
    const reportedCredits = actualCredits;
    const elapsedMs = Date.now() - startedAt.getTime();
    // The claim, the balance move and the closing ledger row commit together. The claim matches the
    // hold's start, so of this frame, a replay, the end endpoint and the stale hold sweep
    // (apps/workers/src/cron/voiceHoldSweep.ts) exactly one settles it, and a failure leaves the
    // hold open for the sweep. Only a realtime hold: an ElevenLabs hold must not settle at the
    // realtime floor from this frame.
    // Logged after the transaction: its callback may run more than once (a transient retry).
    type CloseSettlement = { credits: number; capped: boolean; floor: number | null };
    let closed: CloseSettlement | null;
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    try {
      closed = await withTransaction(async (): Promise<CloseSettlement | null> => {
        const claimed = await sessionRepository.claimVoiceHold(session.id, startedAt, { realtimeOnly: true });
        if (!claimed) return null;
        const billed = claimed.billedCredits ?? 0;
        let credits = reportedCredits;

        // 60-min hard cap: a call that ran over pays at most what is left of its hold
        const capped = elapsedMs > SIXTY_MIN_MS && session.voiceReservedCredits != null;
        if (capped) {
          credits = Math.min(credits, Math.max(0, reserved - billed));
        }

        // Client-reported usage can only raise the settlement: a call never settles below the hold's
        // own rate for the time it has been open by the server's clock, so a zero-usage frame sent
        // mid-call still pays for that call.
        const floor = realtimeCreditsFloor(
          session.voiceReservedCredits ?? usdToCredits(REALTIME_VOICE_RESERVE_USD),
          elapsedSeconds
        );
        const floored = billed + credits < floor;
        if (floored) {
          credits = floor - billed;
        }

        // Already taken: the hold, plus anything billed past it. Owed: everything billed plus this frame.
        const delta = Math.max(0, reserved - billed) - credits;
        if (delta !== 0) {
          await userRepository.incrementCredits(user.id, delta);
        }
        if (credits > 0) {
          await recordVoiceUsage({
            userId: user.id,
            sessionId,
            model,
            credits,
            transactionId: `realtime-voice-close:${sessionId}:${startedAt.toISOString()}`,
          });
        }
        return { credits, capped, floor: floored ? floor : null };
      }, transactionOptions);
    } catch (err) {
      if (!isVoiceLedgerKeyTaken(err)) throw err;
      closed = null;
    }
    if (closed === null) {
      logger.warn(`voiceSessionEnded: session ${sessionId} has no open realtime hold - ignoring`);
      return { statusCode: 200 };
    }
    if (closed.capped) {
      logger.warn(`Voice session ${sessionId} exceeded 60-min cap - clamping credits`, {
        actualCredits: reportedCredits,
        voiceReservedCredits: reserved,
        durationMinutes: Math.round(elapsedMs / 60000),
      });
    }
    if (closed.floor !== null) {
      logger.info(`voiceSessionEnded: session ${sessionId} settled at its connected-time floor`, {
        floor: closed.floor,
        elapsedSeconds,
      });
    }
    actualCredits = closed.credits;
  }

  // Dual-write usage event: analytics only, never billing.
  if (actualCredits > 0 || responseId) {
    usageEventRepository
      .record({
        requestId: responseId ?? sessionId,
        userId: user.id,
        ownerId: user.id,
        ownerType: CreditHolderType.User,
        sessionId,
        feature: 'voice',
        provider: 'openai',
        model,
        inputTokens: usage.textInputTokens + usage.audioInputTokens,
        outputTokens: usage.textOutputTokens + usage.audioOutputTokens,
        cachedInputTokens: usage.textCachedInputTokens + usage.audioCachedInputTokens,
        cacheWriteTokens: 0,
        costUsd: totalUsd,
        creditsCharged: actualCredits,
        status: 'ok',
        latencyMs: session.voiceSessionStartedAt ? Date.now() - new Date(session.voiceSessionStartedAt).getTime() : 0,
      })
      .catch(err => logger.warn('Failed to record usage event', err));
  }

  const credits = actualCredits;

  // Check if credits are now exhausted and enforcement is enabled
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  if (enforceCredits) {
    const updatedUser = await userRepository.findById(userId);
    if (updatedUser && (updatedUser.currentCredits ?? 0) <= 0 && holdLeft <= 0) {
      const { domainName, stage } = event.requestContext;
      const endpoint = `https://${domainName}/${stage}`;
      try {
        await sendToClient(userId, endpoint, {
          action: 'voice_credits_exhausted' as const,
          creditsUsed: credits,
        });
      } catch (err) {
        logger.warn('Failed to send voice_credits_exhausted to client:', err);
      }
    }
  }

  return { statusCode: 200 };
});
