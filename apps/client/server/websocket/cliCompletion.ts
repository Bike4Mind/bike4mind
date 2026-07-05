import { CliCompletionRequestAction, buildSSEEvent, IMessage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { executeCompletion } from '@bike4mind/services';
import {
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  usageEventRepository,
  userRepository,
  userApiKeyRepository,
} from '@bike4mind/database';
import {
  verifyJwtToken,
  checkRateLimit,
  verifyApiKey,
  checkApiKeyRateLimitOrThrow,
  ApiKeyInfo,
} from '@server/cli/auth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { withWebSocketContext, sendToConnection } from '@server/websocket/utils';
import { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { sanitizeErrorMessage } from '@server/utils/errorSanitization';

/**
 * WebSocket handler for CLI LLM completions.
 * Bypasses CloudFront 20s timeout by streaming chunks over WebSocket.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const startTime = Date.now();
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;

  // Parse request body - must catch here to send error with requestId
  let body: ReturnType<typeof CliCompletionRequestAction.parse>;
  try {
    body = CliCompletionRequestAction.parse(JSON.parse(event.body ?? ''));
  } catch (parseError) {
    logger.error('[CLI_WS] Failed to parse request body:', parseError);
    // Try to extract requestId for the error response
    let requestId: string | undefined;
    try {
      requestId = JSON.parse(event.body ?? '').requestId;
    } catch {
      /* body isn't valid JSON */
    }
    if (requestId) {
      await sendToConnection(connectionId, endpoint, {
        action: 'cli_completion_error' as const,
        requestId,
        error: `Invalid request: ${parseError instanceof Error ? parseError.message : 'malformed body'}`,
      });
    }
    return { statusCode: 200 };
  }
  const { accessToken, requestId, model, messages, options } = body;

  // Authenticate (try API key first, then JWT) - same dual-auth as SSE handler
  let userId: string;
  let apiKeyInfo: ApiKeyInfo | undefined;
  let apiKeyInfoForCompletion: { keyId: string; keyName: string } | undefined;

  try {
    apiKeyInfo = await verifyApiKey({ authorization: `Bearer ${accessToken}` });
    userId = apiKeyInfo.userId;
    logger.info('[CLI_WS] Authenticated via API key', { keyId: apiKeyInfo.keyId });

    await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
      userId: apiKeyInfo.userId,
      endpoint: 'ws/cli_completion_request',
      method: 'WS',
    });
  } catch {
    // API key auth failed, try JWT
    try {
      const user = await verifyJwtToken(accessToken);
      userId = user.id;
      logger.info('[CLI_WS] Authenticated via JWT', { userId });
      await checkRateLimit(userId);
    } catch {
      await sendToConnection(connectionId, endpoint, {
        action: 'cli_completion_error' as const,
        requestId,
        error: 'Authentication failed. Provide a valid API key or JWT token.',
      });
      return { statusCode: 200 };
    }
  }

  logger.updateMetadata({ userId, model, requestId });
  logger.info(`[CLI_WS] Starting completion for user ${userId}, model: ${model}`);

  // Track token counts for analytics
  let finalInputTokens = 0;
  let finalOutputTokens = 0;
  let hasToolCalls = false;

  // Resolve API key name for analytics logging
  if (apiKeyInfo) {
    const key = await userApiKeyRepository.findById(apiKeyInfo.keyId);
    if (key) {
      apiKeyInfoForCompletion = { keyId: key.id, keyName: key.name };
    }
  }

  try {
    // Execute completion - same function as SSE handler
    // Cast: Zod parses content/tools as unknown[], but executeCompletion expects typed arrays
    await executeCompletion({
      userId,
      model,
      messages: messages as IMessage[],
      options: options as Parameters<typeof executeCompletion>[0]['options'],
      db: {
        adminSettings: adminSettingsRepository,
        apiKeys: apiKeyRepository,
        creditTransactions: creditTransactionRepository,
        users: userRepository,
        usageEvents: usageEventRepository,
      },
      apiKeyInfo: apiKeyInfoForCompletion,
      requestId,
      logger: logger as unknown as Logger,
      onChunk: async (text, info) => {
        // Track token counts and tool usage
        if (info?.inputTokens) finalInputTokens = info.inputTokens;
        if (info?.outputTokens) finalOutputTokens = info.outputTokens;
        if (info?.toolsUsed && info.toolsUsed.length > 0) hasToolCalls = true;

        const chunk = buildSSEEvent(text, info);
        await sendToConnection(connectionId, endpoint, {
          action: 'cli_completion_chunk' as const,
          requestId,
          chunk,
        });
      },
    });

    // Signal completion
    await sendToConnection(connectionId, endpoint, {
      action: 'cli_completion_done' as const,
      requestId,
    });

    logger.info('[CLI_WS] Completion stream finished successfully');

    // Log analytics
    await logCompletionAnalytics({
      type: 'success',
      userId,
      // WS variant accepts a looser tools shape (z.array(z.unknown())) than
      // CompletionRequestSchema. Cast - analytics only reads model/messages.
      body: { model, messages, options } as Parameters<typeof logCompletionAnalytics>[0]['body'],
      apiKeyInfo: apiKeyInfoForCompletion,
      // WebSocket frames don't carry HTTP headers; this handler is the CLI's
      // streaming path (action `cli_completion_request`), not a public API.
      source: 'cli',
      startTime,
      endpoint: 'ws/cli_completion_request',
      method: 'WS',
      finalInputTokens,
      finalOutputTokens,
      hasToolCalls,
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      logger: logger as unknown as Logger,
    });
  } catch (error) {
    logger.error('[CLI_WS] Completion error:', error);

    // Send error to client
    await sendToConnection(connectionId, endpoint, {
      action: 'cli_completion_error' as const,
      requestId,
      error: sanitizeErrorMessage(error),
    });

    // Log failed analytics
    await logCompletionAnalytics({
      type: 'failure',
      userId,
      // WS variant accepts a looser tools shape (z.array(z.unknown())) than
      // CompletionRequestSchema. Cast - analytics only reads model/messages.
      body: { model, messages, options } as Parameters<typeof logCompletionAnalytics>[0]['body'],
      apiKeyInfo: apiKeyInfoForCompletion,
      source: 'cli',
      startTime,
      endpoint: 'ws/cli_completion_request',
      method: 'WS',
      error,
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      logger: logger as unknown as Logger,
    });
  }

  return { statusCode: 200 };
});
