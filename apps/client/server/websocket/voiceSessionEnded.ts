import { withWebSocketContext, sendToClient } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { pickRealtimeVoiceTier } from '@server/voice/realtimeVoicePricing';
import { CreditHolderType, IModelPrice, VoiceSessionEndedAction, computeRealtimeVoiceUsd } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue, NotFoundError, usdToCreditsStochastic } from '@bike4mind/utils';
import {
  adminSettingsRepository,
  Connection,
  creditTransactionRepository,
  modelPriceRepository,
  sessionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { sessionService, creditService } from '@bike4mind/services';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const { userId, sessionId, model, usage } = VoiceSessionEndedAction.parse(JSON.parse(event.body ?? ''));

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

  // Idempotency guard: voiceSessionStartedAt is set at session start and cleared here on first
  // successful processing. If null, the session either never had voice or was already reconciled.
  if (!session.voiceSessionStartedAt) {
    logger.warn(`voiceSessionEnded: session ${sessionId} has no active voice session - ignoring (possible replay)`);
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

  const { voiceReservedCredits, voiceSessionStartedAt } = session;

  // 60-min hard cap: clamp actual cost to reserved amount if session ran over
  if (voiceSessionStartedAt && voiceReservedCredits != null) {
    const sessionDurationMs = Date.now() - new Date(voiceSessionStartedAt).getTime();
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    if (sessionDurationMs > SIXTY_MIN_MS) {
      logger.warn(`Voice session ${sessionId} exceeded 60-min cap - clamping credits`, {
        actualCredits,
        voiceReservedCredits,
        durationMinutes: Math.round(sessionDurationMs / 60000),
      });
      actualCredits = Math.min(actualCredits, voiceReservedCredits);
    }
  }

  if (voiceReservedCredits != null) {
    // Reservation pattern: balance already decremented at session start.
    // Reconcile: refund overage or charge underage via delta.
    const delta = voiceReservedCredits - actualCredits;
    if (delta !== 0) {
      await userRepository.incrementCredits(user.id, delta);
    }
    // Create audit transaction for actual cost
    await creditService.subtractCredits(
      {
        ownerId: user.id,
        ownerType: CreditHolderType.User,
        credits: actualCredits,
        type: 'realtime_voice_usage',
        model,
        sessionId,
      },
      {
        db: { creditTransactions: creditTransactionRepository },
        creditHolderMethods: userRepository,
        skipBalanceUpdate: true,
        currentCreditHolder: user,
      }
    );
  } else {
    // No reservation (enforceCredits was off at session start) - deduct normally
    await creditService.subtractCredits(
      {
        ownerId: user.id,
        ownerType: CreditHolderType.User,
        credits: actualCredits,
        type: 'realtime_voice_usage',
        model,
        sessionId,
      },
      {
        db: { creditTransactions: creditTransactionRepository },
        creditHolderMethods: userRepository,
      }
    );
  }

  // Dual-write usage event: analytics only, never billing.
  usageEventRepository
    .record({
      requestId: sessionId,
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
      latencyMs: Date.now() - new Date(session.voiceSessionStartedAt).getTime(),
    })
    .catch(err => logger.warn('Failed to record usage event', err));

  // Clear voice reservation fields on session
  await sessionRepository.update({
    id: sessionId,
    voiceReservedCredits: null,
    voiceSessionStartedAt: null,
  });

  const credits = actualCredits;

  // Check if credits are now exhausted and enforcement is enabled
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['enforceCredits'] });
  const enforceCredits = getSettingsValue('enforceCredits', settings);

  if (enforceCredits) {
    const updatedUser = await userRepository.findById(userId);
    if (updatedUser && (updatedUser.currentCredits ?? 0) <= 0) {
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
