import { KeepCommandResponseAction } from '@bike4mind/common';
import { Connection } from '@bike4mind/database/social';
import { withWebSocketContext, sendToConnection } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/**
 * WebSocket handler: Keep (CLI) -> Web HUD result relay
 *
 * Receives a keep_command_response from the CLI after it has executed a command
 * locally. Routes the result directly back to the originating web HUD connection
 * using the originConnectionId embedded in the message.
 *
 * Authentication: The CLI's connection was verified during $connect, so we
 * validate the sender by checking the Connection model for the connectionId.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: ReturnType<typeof KeepCommandResponseAction.parse>;
  try {
    body = KeepCommandResponseAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[KEEP_CMD_RESP] Failed to parse response body:', parseError);
    return { statusCode: 200 };
  }

  const { requestId, originConnectionId, success, result, error } = body;

  // Verify the sender has a valid connection (authenticated during $connect)
  const connection = await Connection.findOne({ connectionId });
  if (!connection) {
    logger.error(`[KEEP_CMD_RESP] Unknown connectionId: ${connectionId}`);
    return { statusCode: 200 };
  }

  logger.info(`[KEEP_CMD_RESP] Relaying result for request ${requestId} back to ${originConnectionId}`);

  // Send result directly to the originating web HUD connection
  try {
    await sendToConnection(originConnectionId, endpoint, {
      action: 'keep_command_result' as const,
      requestId,
      success,
      result,
      error,
    });
  } catch (sendError) {
    logger.error(`[KEEP_CMD_RESP] Failed to relay result to ${originConnectionId}:`, sendError);
  }

  return { statusCode: 200 };
});
