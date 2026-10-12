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
  creditTransactionRepository,
  modelPriceRepository,
  sessionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { connectionHoldsScope } from '@server/websocket/connectionScope';
import { REALTIME_VOICE_RESERVE_USD, realtimeCreditsFloor } from '@server/voice/voiceSessionLimits';

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

  const recordUsage = (credits: number, transactionId?: string) =>
    creditTransactionRepository.createTransaction('realtime_voice_usage', {
      ownerId: user.id,
      ownerType: CreditHolderType.User,
      credits: -Math.abs(credits),
      description: 'Voice usage',
      model,
      sessionId,
      ...(transactionId ? { transactionId } : {}),
    });

  if (responseId) {
    // One response of a live call. The transaction id makes a replayed frame a no-op; the hold
    // stays open, so later responses and a reconnect (which reuses a live hold) keep drawing on it.
    const recorded = await recordUsage(actualCredits, `realtime-voice:${sessionId}:${responseId}`);
    if (!recorded) {
      logger.warn(`voiceSessionEnded: response ${responseId} on session ${sessionId} already billed - ignoring`);
      return { statusCode: 200 };
    }
    const startedAt = session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt) : null;
    let billedBefore: number | null = null;
    try {
      billedBefore = startedAt
        ? await sessionRepository.addVoiceBilledCredits(session.id, startedAt, actualCredits)
        : null;
      // Only the part past the hold leaves the balance now; the hold already covers the rest. With the
      // hold already closed (a close frame that overtook this one) the whole response is charged.
      const fromBalance =
        billedBefore === null
          ? actualCredits
          : Math.max(0, billedBefore + actualCredits - (session.voiceReservedCredits ?? 0)) -
            Math.max(0, billedBefore - (session.voiceReservedCredits ?? 0));
      if (fromBalance > 0) {
        await userRepository.incrementCredits(user.id, -fromBalance);
      }
    } catch (billingError) {
      // The ledger row is this response's replay gate, so a row left behind would make a retried
      // frame a no-op and the response would never be charged. Undo the row and the billed total.
      const billed = billedBefore !== null && startedAt;
      const [unbilled, unrecorded] = await Promise.allSettled([
        billed ? sessionRepository.addVoiceBilledCredits(session.id, startedAt, -actualCredits) : null,
        creditTransactionRepository.delete(recorded.id),
      ]);
      // A null from the revert means the hold was claimed meanwhile, with this response counted in it.
      const undone =
        unrecorded.status === 'fulfilled' && unbilled.status === 'fulfilled' && (!billed || unbilled.value !== null);
      if (!undone) {
        logger.error('voiceSessionEnded: response billing failed and could not be undone', {
          sessionId,
          userId: user.id,
          responseId,
          actualCredits,
        });
      }
      throw billingError;
    }
    if (billedBefore !== null) {
      holdLeft = Math.max(0, (session.voiceReservedCredits ?? 0) - billedBefore - actualCredits);
    }
  } else {
    // The call is over: bill this frame's usage and refund what the hold did not cover. Older
    // clients send exactly one of these per call, so this is also their whole settlement.
    if (!session.voiceSessionStartedAt) {
      logger.warn(`voiceSessionEnded: session ${sessionId} has no active voice session - ignoring (possible replay)`);
      return { statusCode: 200 };
    }
    const startedAt = new Date(session.voiceSessionStartedAt);
    // Claim the hold before any credit moves: of this frame, a replay, the end endpoint and the
    // stale hold sweep (apps/workers/src/cron/voiceHoldSweep.ts), exactly one settles it.
    const claimed = await sessionRepository.claimVoiceHold(session.id, startedAt);
    if (!claimed) {
      logger.warn(`voiceSessionEnded: session ${sessionId} hold already settled - ignoring`);
      return { statusCode: 200 };
    }
    const billed = claimed.billedCredits ?? 0;
    const reserved = session.voiceReservedCredits ?? 0;

    // 60-min hard cap: a call that ran over pays at most what is left of its hold
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    if (Date.now() - startedAt.getTime() > SIXTY_MIN_MS && session.voiceReservedCredits != null) {
      const capped = Math.max(0, reserved - billed);
      logger.warn(`Voice session ${sessionId} exceeded 60-min cap - clamping credits`, {
        actualCredits,
        voiceReservedCredits: reserved,
        durationMinutes: Math.round((Date.now() - startedAt.getTime()) / 60000),
      });
      actualCredits = Math.min(actualCredits, capped);
    }

    // Client-reported usage can only raise the settlement: a call never settles below the hold's
    // own rate for the time it has been open by the server's clock, so a zero-usage frame sent
    // mid-call still pays for that call.
    const elapsedSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const floor = realtimeCreditsFloor(
      session.voiceReservedCredits ?? usdToCredits(REALTIME_VOICE_RESERVE_USD),
      elapsedSeconds
    );
    if (billed + actualCredits < floor) {
      logger.info(`voiceSessionEnded: session ${sessionId} settled at its connected-time floor`, {
        reportedCredits: billed + actualCredits,
        floor,
        elapsedSeconds,
      });
      actualCredits = floor - billed;
    }

    // Already taken: the hold, plus anything billed past it. Owed: everything billed plus this frame.
    // The balance moves before the ledger row, so a failed ledger write loses only the audit row,
    // never the refund. If the balance move fails the hold is restored (as settleVoiceHold does)
    // so a retried frame or the stale-hold sweep can still settle it.
    const delta = Math.max(0, reserved - billed) - actualCredits;
    if (delta !== 0) {
      try {
        await userRepository.incrementCredits(user.id, delta);
      } catch (creditError) {
        const restored = await sessionRepository
          .restoreVoiceHold(session.id, reserved, startedAt, claimed.billedCredits)
          .catch(restoreError => {
            throw new AggregateError(
              [creditError, restoreError],
              `voice hold ${sessionId}: settlement failed and the hold could not be restored`
            );
          });
        // A newer call already holds the session, so no retry can settle this hold.
        if (!restored) {
          logger.error('voiceSessionEnded: settlement failed and a newer hold blocks restoring this one', {
            sessionId,
            userId: user.id,
            startedAt: startedAt.toISOString(),
            actualCredits,
            delta,
          });
        }
        throw creditError;
      }
    }
    if (actualCredits > 0) {
      await recordUsage(actualCredits);
    }
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
