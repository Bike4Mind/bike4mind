import { Connection, questRepository, sessionRepository, userRepository } from '@bike4mind/database';
import { VoiceSessionSendTranscriptAction } from '@bike4mind/common';
import { sessionService } from '@bike4mind/services';
import { NotFoundError } from '@server/utils/errors';
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
    logger.warn('voiceSessionSendTranscript userId mismatch or unknown connection — rejecting', {
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

  if (type === 'input') {
    await questRepository.upsertBySessionIdAndConversationItemId(sessionId, conversationItemId, {
      prompt: transcript,
      status: 'done',
      type: 'voice_transcript',
      ...(timestamp ? { timestamp } : {}),
    });
  } else {
    await questRepository.upsertBySessionIdAndConversationItemId(sessionId, conversationItemId, {
      replies: [transcript],
      status: 'done',
      type: 'voice_transcript',
      ...(timestamp ? { timestamp } : {}),
    });
  }

  return { statusCode: 200 };
});
