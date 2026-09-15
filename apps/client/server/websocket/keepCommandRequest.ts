import { KeepCommandRequestAction } from '@bike4mind/common';
import { verifyJwtToken, checkRateLimit, verifyApiKey, checkApiKeyRateLimitOrThrow } from '@server/cli/auth';
import { withWebSocketContext, sendToClient, sendToConnection } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';

/**
 * WebSocket handler: Web HUD -> Keep (CLI) command relay
 *
 * Receives a keep_command_request from the web HUD, authenticates the sender,
 * then broadcasts a keep_command to all of the user's connections. The CLI
 * picks it up; web connections ignore the unknown action.
 *
 * The originConnectionId is set to the sender's connectionId so the CLI's
 * response can be routed directly back to the requesting web connection.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, _context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: ReturnType<typeof KeepCommandRequestAction.parse>;
  try {
    body = KeepCommandRequestAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[KEEP_CMD_REQ] Failed to parse request body:', parseError);
    let requestId: string | undefined;
    try {
      requestId = JSON.parse(event.body ?? '').requestId;
    } catch {
      /* body isn't valid JSON */
    }
    if (requestId) {
      await sendToConnection(connectionId, endpoint, {
        action: 'keep_command_result' as const,
        requestId,
        success: false,
        error: `Invalid request: ${parseError instanceof Error ? parseError.message : 'malformed body'}`,
      });
    }
    return { statusCode: 200 };
  }

  const { accessToken, requestId, commandType, params } = body;

  // Authenticate (try API key first, then JWT)
  let userId: string;
  try {
    const apiKeyInfo = await verifyApiKey({ authorization: `Bearer ${accessToken}` });
    userId = apiKeyInfo.userId;
    await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
      userId: apiKeyInfo.userId,
      endpoint: 'ws/keep_command_request',
      method: 'WS',
    });
  } catch {
    try {
      const user = await verifyJwtToken(accessToken);
      userId = user.id;
      await checkRateLimit(userId);
    } catch {
      await sendToConnection(connectionId, endpoint, {
        action: 'keep_command_result' as const,
        requestId,
        success: false,
        error: 'Authentication failed. Provide a valid API key or JWT token.',
      });
      return { statusCode: 200 };
    }
  }

  logger.info(`[KEEP_CMD_REQ] User ${userId} requesting ${commandType} via Keep relay`);

  // Relay to all user connections - CLI will handle keep_command, web ignores it
  await sendToClient(userId, endpoint, {
    action: 'keep_command' as const,
    commandType,
    params,
    requestId,
    originConnectionId: connectionId,
  });

  return { statusCode: 200 };
});
