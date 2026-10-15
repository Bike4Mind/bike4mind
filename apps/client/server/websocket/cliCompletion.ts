import {
  CliCompletionRequestAction,
  buildSSEEvent,
  IMessage,
  type CompletionSource,
  type TurnUsage,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { executeCompletion } from '@bike4mind/services/cliCompletions';
import {
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  usageEventRepository,
  userRepository,
  userApiKeyRepository,
  organizationRepository,
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
import { TooManyRequestsError } from '@server/utils/errors';

const AUTH_FAILED_MESSAGE = 'Authentication failed. Provide a valid API key or JWT token.';

/**
 * A rate-limit refusal keeps its message and `retryAfter` (seconds); anything else is a plain auth failure.
 * The message is built by the limiter itself, so it is passed through as-is: sanitizeErrorMessage matches
 * a lowercase "rate limit" and would turn "Rate limit exceeded" into a generic internal error.
 */
function rateLimitOrAuthError(requestId: string, error: unknown) {
  if (error instanceof TooManyRequestsError) {
    const retryAfter = error.additionalInfo?.retryAfter;
    return {
      action: 'cli_completion_error' as const,
      requestId,
      error: error.message,
      ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
    };
  }
  return { action: 'cli_completion_error' as const, requestId, error: AUTH_FAILED_MESSAGE };
}

/**
 * WebSocket handler for CLI LLM completions.
 * Bypasses CloudFront 20s timeout by streaming chunks over WebSocket.
 */
export const func = withWebSocketContext<APIGatewayProxyWebsocketEventV2>(async (event, context, logger) => {
  const startTime = Date.now();
  const { connectionId, domainName, stage } = event.requestContext;
  const endpoint = `https://${domainName}/${stage}`;
  // WS frames carry no HTTP headers, so the source is fixed here rather than sniffed. This
  // handler only serves the CLI's streaming path. Mirrors wsRoute.ts.
  const source: CompletionSource = 'cli';

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
  } catch (apiKeyError) {
    // A present-but-rate-limited key reports its own limit rather than falling through to JWT.
    if (apiKeyInfo) {
      if (!(apiKeyError instanceof TooManyRequestsError)) {
        logger.warn('[CLI_WS] API key rate-limit check failed unexpectedly', {
          keyId: apiKeyInfo.keyId,
          error: apiKeyError instanceof Error ? apiKeyError.message : String(apiKeyError),
        });
      }
      await sendToConnection(connectionId, endpoint, rateLimitOrAuthError(requestId, apiKeyError));
      return { statusCode: 200 };
    }
    try {
      const user = await verifyJwtToken(accessToken);
      userId = user.id;
      logger.info('[CLI_WS] Authenticated via JWT', { userId });
      await checkRateLimit(userId, source);
    } catch (jwtError) {
      if (!(jwtError instanceof TooManyRequestsError)) {
        logger.warn('[CLI_WS] JWT authentication failed', {
          error: jwtError instanceof Error ? jwtError.message : String(jwtError),
        });
      }
      await sendToConnection(connectionId, endpoint, rateLimitOrAuthError(requestId, jwtError));
      return { statusCode: 200 };
    }
  }

  logger.updateMetadata({ userId, model, requestId });
  logger.info(`[CLI_WS] Starting completion for user ${userId}, model: ${model}`);

  // Track token counts for analytics
  let finalInputTokens = 0;
  let finalOutputTokens = 0;
  let finalCacheReadTokens = 0;
  let finalCacheWriteTokens = 0;
  let finalTurnUsage: TurnUsage[] | undefined;
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
        organizations: organizationRepository,
      },
      apiKeyInfo: apiKeyInfoForCompletion,
      // Org-billed API keys settle to the org's shared pool.
      billingOrganizationId: apiKeyInfo?.organizationId,
      requestId,
      source,
      logger: logger as unknown as Logger,
      onChunk: async (text, info) => {
        // Track token counts and tool usage
        if (info?.inputTokens) finalInputTokens = info.inputTokens;
        if (info?.outputTokens) finalOutputTokens = info.outputTokens;
        if (info?.cacheReadInputTokens) finalCacheReadTokens = info.cacheReadInputTokens;
        if (info?.cacheCreationInputTokens) finalCacheWriteTokens = info.cacheCreationInputTokens;
        if (info?.turnUsage?.length) finalTurnUsage = info.turnUsage;
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
      source,
      startTime,
      endpoint: 'ws/cli_completion_request',
      method: 'WS',
      finalInputTokens,
      finalOutputTokens,
      finalCacheReadTokens,
      finalCacheWriteTokens,
      finalTurnUsage,
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
      source,
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
