import { withWebSocketContext, sendToClient } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { CreditHolderType, IVoiceSessionEndedAction, VoiceSessionEndedAction } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue, NotFoundError, usdToCredits } from '@bike4mind/utils';
import {
  adminSettingsRepository,
  Connection,
  creditTransactionRepository,
  sessionRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { sessionService, creditService } from '@bike4mind/services';

const GPT_REALTIME_PRICING_TABLE = {
  text: {
    input: 4 / 1_000_000,
    cachedInput: 0.4 / 1_000_000,
    output: 16 / 1_000_000,
  },
  audio: {
    input: 32 / 1_000_000,
    cachedInput: 0.4 / 1_000_000,
    output: 64 / 1_000_000,
  },
} as const;

function calculateGPTRealtimeCredits(usage: IVoiceSessionEndedAction['usage']) {
  let credits: number = 0;
  credits += usdToCredits(GPT_REALTIME_PRICING_TABLE.text.input * usage.textInputTokens);
  credits += usdToCredits(GPT_REALTIME_PRICING_TABLE.text.cachedInput * usage.textCachedInputTokens);
  credits += usdToCredits(GPT_REALTIME_PRICING_TABLE.text.output * usage.textOutputTokens);
  credits += usdToCredits(GPT_REALTIME_PRICING_TABLE.audio.input * usage.audioInputTokens);
  credits += usdToCredits(GPT_REALTIME_PRICING_TABLE.audio.cachedInput * usage.audioCachedInputTokens);
  credits += usdToCredits(GPT_REALTIME_PRICING_TABLE.audio.output * usage.audioOutputTokens);

  return credits;
}

// USD twin of calculateGPTRealtimeCredits for the usage-event dual write: same
// per-component amounts, summed before credit conversion. Analytics only, never billing.
function calculateGPTRealtimeUsd(usage: IVoiceSessionEndedAction['usage']) {
  return (
    GPT_REALTIME_PRICING_TABLE.text.input * usage.textInputTokens +
    GPT_REALTIME_PRICING_TABLE.text.cachedInput * usage.textCachedInputTokens +
    GPT_REALTIME_PRICING_TABLE.text.output * usage.textOutputTokens +
    GPT_REALTIME_PRICING_TABLE.audio.input * usage.audioInputTokens +
    GPT_REALTIME_PRICING_TABLE.audio.cachedInput * usage.audioCachedInputTokens +
    GPT_REALTIME_PRICING_TABLE.audio.output * usage.audioOutputTokens
  );
}

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const { userId, sessionId, model, usage } = VoiceSessionEndedAction.parse(JSON.parse(event.body ?? ''));

  // Verify the claimed userId matches the authenticated connection owner.
  // withWebSocketContext does not inject the authenticated user - the connectionId
  // is the server-authoritative identity source stored at connect time.
  const connectionId = event.requestContext.connectionId;
  const connection = await Connection.findOne({ connectionId });
  if (!connection || connection.userId !== userId) {
    logger.warn('voiceSessionEnded userId mismatch or unknown connection — rejecting', {
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
    logger.warn(`voiceSessionEnded: session ${sessionId} has no active voice session — ignoring (possible replay)`);
    return { statusCode: 200 };
  }

  let actualCredits: number = calculateGPTRealtimeCredits(usage);

  const { voiceReservedCredits, voiceSessionStartedAt } = session;

  // 60-min hard cap: clamp actual cost to reserved amount if session ran over
  if (voiceSessionStartedAt && voiceReservedCredits != null) {
    const sessionDurationMs = Date.now() - new Date(voiceSessionStartedAt).getTime();
    const SIXTY_MIN_MS = 60 * 60 * 1000;
    if (sessionDurationMs > SIXTY_MIN_MS) {
      logger.warn(`Voice session ${sessionId} exceeded 60-min cap — clamping credits`, {
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
      costUsd: calculateGPTRealtimeUsd(usage),
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
