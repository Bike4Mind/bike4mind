import { Connection, questRepository, userRepository } from '@bike4mind/database';
import { Session as SessionModel } from '@bike4mind/database/auth';
import { ApiKeyScope, Permission, VoiceSessionSendTranscriptAction } from '@bike4mind/common';
import { accessibleBy } from '@casl/mongoose';
import ability from '@server/auth/ability';
import { NotFoundError } from '@server/utils/errors';
import { connectionHoldsScope } from '@server/websocket/connectionScope';
import { withWebSocketContext } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const { userId, sessionId, transcript, type, conversationItemId, timestamp } = VoiceSessionSendTranscriptAction.parse(
    JSON.parse(event.body ?? '')
  );

  // Verify the claimed userId matches the authenticated connection owner.
  // withWebSocketContext does not inject the authenticated user - the connectionId
  // is the server-authoritative identity source stored at connect time.
  const connectionId = event.requestContext.connectionId;
  const connection = await Connection.findOne({ connectionId });
  if (!connection || connection.userId !== userId) {
    logger.warn('voiceSessionSendTranscript userId mismatch or unknown connection - rejecting', {
      connectionId,
      claimedUserId: userId,
    });
    return { statusCode: 200 };
  }

  // This frame writes conversation history. A key minted only to run the cc-bridge can open a
  // socket, and must not be able to author turns in its owner's notebooks.
  if (!connectionHoldsScope(connection, [ApiKeyScope.AI_CHAT])) {
    logger.warn('voiceSessionSendTranscript from a connection without ai:chat scope - rejecting', {
      connectionId,
      claimedUserId: userId,
    });
    return { statusCode: 200 };
  }

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  // Write access, not read access. Read-accessibility admits a sharee holding only [read, share],
  // and this handler inserts and overwrites turns in the notebook - the same `Permission.update`
  // predicate every HTTP session-write path applies (sessionCrud.ts, sessionOperations.ts).
  const writableSession = await SessionModel.findOne({
    _id: sessionId,
    ...accessibleBy(ability(user), Permission.update).ofType(SessionModel),
  });
  if (!writableSession) {
    logger.warn(`voiceSessionSendTranscript: session ${sessionId} not found or not writable by ${userId}`);
    return { statusCode: 200 };
  }

  const turn =
    type === 'input'
      ? { prompt: transcript, status: 'done' as const, type: 'voice_transcript' as const }
      : { replies: [transcript], status: 'done' as const, type: 'voice_transcript' as const };

  await questRepository.upsertVoiceTranscriptTurn(sessionId, conversationItemId, userId, {
    ...turn,
    ...(timestamp ? { timestamp } : {}),
  });

  return { statusCode: 200 };
});
