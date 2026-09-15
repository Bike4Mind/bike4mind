import { CliToolRequestAction } from '@bike4mind/common';
import { verifyJwtToken, checkRateLimit, verifyApiKey, checkApiKeyRateLimitOrThrow } from '@server/cli/auth';
import { validateToolRequest, executeToolWithLogging } from '@server/cli/toolsHandler.shared';
import { withWebSocketContext, sendToConnection } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { sanitizeErrorMessage } from '@server/utils/errorSanitization';

/**
 * WebSocket handler for CLI tool execution (request-response)
 * Bypasses CloudFront 20s timeout for long-running tool operations
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  let body: ReturnType<typeof CliToolRequestAction.parse>;
  try {
    body = CliToolRequestAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[CLI_WS_TOOL] Failed to parse request body:', parseError);
    let requestId: string | undefined;
    try {
      requestId = JSON.parse(event.body ?? '').requestId;
    } catch {
      /* body isn't valid JSON */
    }
    if (requestId) {
      await sendToConnection(connectionId, endpoint, {
        action: 'cli_tool_response' as const,
        requestId,
        success: false,
        error: `Invalid request: ${parseError instanceof Error ? parseError.message : 'malformed body'}`,
      });
    }
    return { statusCode: 200 };
  }
  const { accessToken, requestId, toolName, input } = body;

  // Authenticate (try API key first, then JWT)
  let userId: string;
  let userEmail: string | undefined;

  try {
    const apiKeyInfo = await verifyApiKey({ authorization: `Bearer ${accessToken}` });
    userId = apiKeyInfo.userId;

    await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
      userId: apiKeyInfo.userId,
      endpoint: 'ws/cli_tool_request',
      method: 'WS',
    });
  } catch {
    try {
      const user = await verifyJwtToken(accessToken);
      userId = user.id;
      userEmail = user.email ?? undefined;
      await checkRateLimit(userId);
    } catch {
      await sendToConnection(connectionId, endpoint, {
        action: 'cli_tool_response' as const,
        requestId,
        success: false,
        error: 'Authentication failed. Provide a valid API key or JWT token.',
      });
      return { statusCode: 200 };
    }
  }

  // Validate tool request
  const validation = validateToolRequest({ toolName, input });
  if (!validation.valid) {
    await sendToConnection(connectionId, endpoint, {
      action: 'cli_tool_response' as const,
      requestId,
      success: false,
      error: validation.error,
    });
    return { statusCode: 200 };
  }

  try {
    const result = await executeToolWithLogging(validation.data, {
      userId,
      userEmail,
      logger,
    });

    await sendToConnection(connectionId, endpoint, {
      action: 'cli_tool_response' as const,
      requestId,
      success: result.success,
      content: result.success ? result.content : undefined,
      error: result.error,
    });
  } catch (error) {
    logger.error('[CLI_WS_TOOL] Tool execution error:', error);

    await sendToConnection(connectionId, endpoint, {
      action: 'cli_tool_response' as const,
      requestId,
      success: false,
      error: sanitizeErrorMessage(error),
    });
  }

  return { statusCode: 200 };
});
