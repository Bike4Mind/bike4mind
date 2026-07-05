import {
  CompletionRequestSchema,
  buildSSEEvent,
  IMessage,
  normalizeCompletionRequest,
  type CompletionSource,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { executeCompletion } from '@bike4mind/services';
import { Config } from '@server/utils/config';
import {
  connectDB,
  mongoose,
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  usageEventRepository,
  userRepository,
  userApiKeyRepository,
} from '@bike4mind/database';
import { Connection } from '@bike4mind/database/social';
import { verifyJwtToken, checkRateLimit, verifyApiKey, checkApiKeyRateLimitOrThrow, ApiKeyInfo } from './auth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { sendToConnection } from '@server/websocket/utils';
import { Resource } from 'sst';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { sanitizeErrorMessage } from '@server/utils/errorSanitization';

const WsCompletionRequestSchema = CompletionRequestSchema.extend({
  requestId: z.uuid(),
  connectionId: z.string().optional(),
});

/**
 * HTTP handler for CLI completions with WebSocket response streaming.
 *
 * The CLI sends the full request payload via HTTP POST (no 32KB WebSocket frame limit),
 * and receives streaming chunks via its existing WebSocket connection.
 *
 * Flow:
 *  1. CLI registers a WebSocket handler for `requestId`
 *  2. CLI POSTs here with { requestId, model, messages, options }
 *  3. This handler runs executeCompletion, streams chunks via sendToConnection
 *  4. Returns HTTP 200 when complete
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const startTime = Date.now();
  const logger = new Logger();

  // Derive WebSocket management endpoint from the WebSocket URL
  const wsEndpoint = (Resource.websocket as { url: string }).url.replace('wss://', 'https://');

  let body: z.infer<typeof WsCompletionRequestSchema> | undefined;
  let userId: string | undefined;
  let apiKeyInfo: ApiKeyInfo | undefined;
  let apiKeyInfoForCompletion: { keyId: string; keyName: string } | undefined;

  // This endpoint is the CLI's HTTP->WS completion path - it requires an
  // already-registered CLI WebSocket connection, so it can only be reached by
  // the CLI. Hardcode 'cli' to match the WS-frame handler (cliCompletion.ts).
  // If a non-CLI client ever needs this endpoint, swap back to
  // resolveApiCompletionSource(event.headers || {}) and keep both paths aligned.
  const source: CompletionSource = 'cli';

  try {
    // Connect to database
    if (mongoose.connection.readyState !== 1) {
      await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
    }

    // Parse request body
    const rawBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    body = normalizeCompletionRequest(WsCompletionRequestSchema.parse(rawBody));
    const { requestId, model, messages, options } = body;

    // Authenticate (try API key first, then JWT)
    try {
      apiKeyInfo = await verifyApiKey(event.headers || {});
      userId = apiKeyInfo.userId;
      logger.info('[CLI_WS_HTTP] Authenticated via API key', { keyId: apiKeyInfo.keyId });

      await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
        userId: apiKeyInfo.userId,
        endpoint: event.rawPath || '/ws-completions',
        method: 'POST',
      });
    } catch {
      const token = event.headers?.authorization?.replace('Bearer ', '');
      try {
        const user = await verifyJwtToken(token);
        userId = user.id;
        logger.info('[CLI_WS_HTTP] Authenticated via JWT', { userId });
        await checkRateLimit(userId, source);
      } catch {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: 'Authentication failed' }),
        };
      }
    }

    logger.updateMetadata({ userId, model, requestId });
    logger.info(`[CLI_WS_HTTP] Starting completion for user ${userId}, model: ${model}`);

    // Find user's WebSocket connections
    const connections = await Connection.find({ userId });
    if (connections.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'No active WebSocket connection found' }),
      };
    }

    // Track token counts for analytics
    let finalInputTokens = 0;
    let finalOutputTokens = 0;
    let hasToolCalls = false;

    // Resolve API key name for analytics
    if (apiKeyInfo) {
      const key = await userApiKeyRepository.findById(apiKeyInfo.keyId);
      if (key) {
        apiKeyInfoForCompletion = { keyId: key.id, keyName: key.name };
      }
    }

    // Prefer sending to the requesting CLI's connection, fall back to all connections
    const targetConnections = body?.connectionId
      ? connections.filter(conn => conn.connectionId === body!.connectionId)
      : connections;
    // Fall back to all connections if target not found (e.g., reconnected with new connectionId)
    const effectiveConnections = targetConnections.length > 0 ? targetConnections : connections;

    const sendToConnections = async (data: Record<string, unknown>): Promise<void> => {
      await Promise.allSettled(
        effectiveConnections.map(conn => sendToConnection(conn.connectionId, wsEndpoint, data as never))
      );
    };

    // Execute completion and stream via WebSocket
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
      source,
      logger,
      onChunk: async (text, info) => {
        if (info?.inputTokens) finalInputTokens = info.inputTokens;
        if (info?.outputTokens) finalOutputTokens = info.outputTokens;
        if (info?.toolsUsed && info.toolsUsed.length > 0) hasToolCalls = true;

        const chunk = buildSSEEvent(text, info);
        await sendToConnections({
          action: 'cli_completion_chunk' as const,
          requestId,
          chunk,
        });
      },
    });

    // Signal completion
    await sendToConnections({
      action: 'cli_completion_done' as const,
      requestId,
    });

    logger.info('[CLI_WS_HTTP] Completion stream finished successfully');

    // Log analytics
    await logCompletionAnalytics({
      type: 'success',
      userId,
      body: { model, messages, options },
      apiKeyInfo: apiKeyInfoForCompletion,
      source,
      startTime,
      endpoint: 'ws-completions',
      method: 'POST',
      finalInputTokens,
      finalOutputTokens,
      hasToolCalls,
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      logger,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    logger.error('[CLI_WS_HTTP] Completion error:', error);

    // Try to send error via WebSocket if we have connections
    if (userId && body?.requestId) {
      try {
        const errorConnections = await Connection.find({ userId });
        const errorTargetConnections = body!.connectionId
          ? errorConnections.filter(conn => conn.connectionId === body!.connectionId)
          : errorConnections;
        const errorEffectiveConnections = errorTargetConnections.length > 0 ? errorTargetConnections : errorConnections;
        await Promise.allSettled(
          errorEffectiveConnections.map(conn =>
            sendToConnection(conn.connectionId, wsEndpoint, {
              action: 'cli_completion_error' as const,
              requestId: body!.requestId,
              error: sanitizeErrorMessage(error),
            } as never)
          )
        );
      } catch {
        // Best effort
      }
    }

    // Log failed analytics
    if (userId && body) {
      await logCompletionAnalytics({
        type: 'failure',
        userId,
        body: { model: body.model, messages: body.messages, options: body.options },
        apiKeyInfo: apiKeyInfoForCompletion,
        source,
        startTime,
        endpoint: 'ws-completions',
        method: 'POST',
        error,
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        logger,
      });
    }

    return {
      statusCode: 500,
      body: JSON.stringify({ error: sanitizeErrorMessage(error) }),
    };
  }
};
