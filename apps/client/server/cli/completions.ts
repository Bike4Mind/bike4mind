import {
  CompletionRequestSchema,
  LEGACY_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  buildMetaEvent,
  buildSSEEvent,
  formatSSEError,
  normalizeCompletionRequest,
  resolveApiCompletionSource,
  resolveRequestId,
  serializeSSEEvent,
  SSE_DONE_SIGNAL,
  SSE_KEEPALIVE,
  type CompletionSource,
} from '@bike4mind/common';
import { registerLambdaErrorHandlers } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

// Register global error handlers for network-error observability
registerLambdaErrorHandlers();
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
import { verifyJwtToken, checkRateLimit, verifyApiKey, checkApiKeyRateLimitOrThrow, ApiKeyInfo } from './auth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { z } from 'zod';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { streamifyResponse, ResponseStream } from 'lambda-stream';

/**
 * Lambda handler for CLI LLM completions
 * Uses Lambda streaming response mode for Server-Sent Events (SSE)
 *
 * Works in both local development (`sst dev`) and deployed environments.
 * Routed via CloudFront at /api/ai/v1/completions. The function URL is
 * also exposed via /api/settings/serverConfig so the CLI can call it
 * directly (bypassing the Next.js dev server in local dev).
 *
 * WHY Lambda instead of Next.js API?
 * - API Gateway has a hard 29-second timeout limit
 * - Complex LLM completions (long prompts, multi-turn conversations, tool use) often exceed 29s
 * - Lambda with streaming can run much longer (up to 15 minutes)
 * - Streaming SSE allows real-time token delivery without waiting for full completion
 */
export const handler = streamifyResponse(
  async (event: APIGatewayProxyEventV2, responseStream: ResponseStream): Promise<void> => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const logger = new Logger();

      // Correlation ID - accept the caller's value (sanitized) or generate one.
      const requestId = resolveRequestId(
        event.headers?.[REQUEST_ID_HEADER.toLowerCase()],
        event.headers?.[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
      );
      logger.updateMetadata({ requestId });

      let body: z.infer<typeof CompletionRequestSchema> | undefined;
      let userId: string | undefined;
      let apiKeyInfo: ApiKeyInfo | undefined;
      let apiKeyInfoForCompletion: { keyId: string; keyName: string } | undefined;

      // Determine the request source from the User-Agent / X-B4M-Client header.
      // The /api/ai/v1/completions endpoint is shared by the CLI and 3rd-party
      // API consumers; we distinguish CLI by the `b4m-cli/<version>` UA the CLI
      // axios client sets. Resolved once, used for both the credit transaction
      // and the analytics event so reports can break down usage by surface.
      const source: CompletionSource = resolveApiCompletionSource(event.headers || {});

      // Use IIFE to allow async/await inside Promise executor
      (async () => {
        // Set SSE content type before any async work
        responseStream.setContentType('text/event-stream');

        // Send an immediate keep-alive comment to establish the stream.
        // This prevents CloudFront from issuing a 504 during the pre-LLM work
        // (DB connect, auth, rate limiting) which can exceed the default 30s
        // origin response timeout before the first real byte is written.
        responseStream.write(SSE_KEEPALIVE);

        // Emit the request's correlation ID as the first non-keepalive event
        // so the caller can correlate this stream with server logs.
        responseStream.write(serializeSSEEvent(buildMetaEvent(requestId)));

        // Periodic heartbeat - an intermediary (CloudFront / the socket layer)
        // closes the connection if no bytes arrive for too long. During an
        // extended-thinking step the model emits no tokens, so this is the
        // ONLY thing keeping the stream open. The previous 25s interval fired
        // its first beat too late: a real drop was observed at ~23s on a long
        // thinking gap (Error: aborted from node:_http_client socketCloseListener),
        // i.e. before the first heartbeat ever ran. Beat every 10s so bytes
        // flow with a comfortable (>2x) margin under any plausible idle ceiling.
        // SSE comments are spec-compliant and invisible to EventSource; no
        // client-side handling is needed.
        const HEARTBEAT_INTERVAL_MS = 10_000;
        const heartbeat = setInterval(() => {
          responseStream.write(SSE_KEEPALIVE);
        }, HEARTBEAT_INTERVAL_MS);

        try {
          // 1. Connect to database (mongoose.connection is a singleton)
          if (mongoose.connection.readyState !== 1) {
            await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
          }

          // 2. Parse request body
          try {
            const rawBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
            body = normalizeCompletionRequest(CompletionRequestSchema.parse(rawBody));
          } catch (error) {
            const errorEvent = formatSSEError(new Error('Invalid request body'), requestId);
            responseStream.write(serializeSSEEvent(errorEvent));
            responseStream.end();
            return reject(new Error('Invalid request body'));
          }

          // 3. Authenticate (try API key first, then JWT)

          // Try API key authentication first
          try {
            apiKeyInfo = await verifyApiKey(event.headers || {});
            userId = apiKeyInfo.userId;
            logger.info('[CLI_LLM] Authenticated via API key', { keyId: apiKeyInfo.keyId });

            // Check API key rate limits (analytics logging handled internally)
            try {
              const rateLimitHeaders = await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
                userId: apiKeyInfo.userId,
                endpoint: event.rawPath || '/api/ai/v1/completions',
                method: event.requestContext?.http?.method || 'POST',
              });

              // TODO: Set rate limit headers in Lambda response metadata if possible
              // Lambda streaming responses with SSE don't support custom headers easily
              // Consider: responseStream.setMetadata() or custom SSE event for rate limit info
              logger.debug('[CLI_LLM] Rate limit headers:', rateLimitHeaders);
            } catch (error) {
              const errorEvent = formatSSEError(
                error instanceof Error ? error : new Error('Rate limit exceeded'),
                requestId
              );
              responseStream.write(serializeSSEEvent(errorEvent));
              responseStream.end();
              return reject(error);
            }
          } catch (apiKeyError) {
            // API key auth failed, try JWT token
            const token = event.headers?.authorization?.replace('Bearer ', '');
            try {
              const user = await verifyJwtToken(token);
              userId = user.id;
              logger.info('[CLI_LLM] Authenticated via JWT', { userId });

              // Check JWT rate limit (shared cache; per-source caps - CLI
              // tool loops need a much higher ceiling than browser chat)
              try {
                await checkRateLimit(userId, source);
              } catch (error) {
                const errorEvent = formatSSEError(
                  error instanceof Error ? error : new Error('Rate limit exceeded'),
                  requestId
                );
                responseStream.write(serializeSSEEvent(errorEvent));
                responseStream.end();
                return reject(error);
              }
            } catch (jwtError) {
              // Both auth methods failed
              const errorEvent = formatSSEError(
                new Error('Authentication failed. Provide a valid API key or JWT token.'),
                requestId
              );
              responseStream.write(serializeSSEEvent(errorEvent));
              responseStream.end();
              return reject(new Error('Authentication failed'));
            }
          }

          logger.updateMetadata({ userId, model: body.model, apiKeyId: apiKeyInfo?.keyId });
          logger.info(`[CLI_LLM] Starting completion for user ${userId}, model: ${body.model}`, {
            authMethod: apiKeyInfo ? 'api_key' : 'jwt',
            apiKeyId: apiKeyInfo?.keyId,
          });

          // 4. Track token counts and tool usage for analytics
          let finalInputTokens = 0;
          let finalOutputTokens = 0;
          let hasToolCalls = false;

          // 5. Get API key name if authenticated via API key
          if (apiKeyInfo) {
            const userApiKey = await userApiKeyRepository.findById(apiKeyInfo.keyId);
            if (userApiKey) {
              apiKeyInfoForCompletion = {
                keyId: userApiKey.id,
                keyName: userApiKey.name,
              };
            }
          }

          // 6. Execute completion with shared service
          await executeCompletion({
            userId,
            model: body.model,
            messages: body.messages,
            options: body.options,
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
              // Track token counts and tool usage from completion info
              if (info?.inputTokens) finalInputTokens = info.inputTokens;
              if (info?.outputTokens) finalOutputTokens = info.outputTokens;
              if (info?.toolsUsed && info.toolsUsed.length > 0) hasToolCalls = true;

              // Log credit/usage info when present
              if (info?.creditsUsed || info?.usdCost || info?.inputTokens || info?.outputTokens) {
                logger.info('[CLI_LLM] Sending SSE event with usage/credits', {
                  creditsUsed: info.creditsUsed,
                  usdCost: info.usdCost,
                  inputTokens: info.inputTokens,
                  outputTokens: info.outputTokens,
                  hasText: (text[0]?.length || 0) + (text[1]?.length || 0) > 0,
                });
              }

              logger.debug('[CLI_LLM] Callback invoked', {
                textLength: text[0]?.length,
                hasToolsUsed: !!info?.toolsUsed,
              });
              const event = buildSSEEvent(text, info);
              responseStream.write(serializeSSEEvent(event));
            },
          });

          // 7. Close stream
          responseStream.write(SSE_DONE_SIGNAL);
          responseStream.end();

          logger.info('[CLI_LLM] Completion stream finished successfully');

          // 8. Log analytics events
          await logCompletionAnalytics({
            type: 'success',
            requestId,
            userId,
            body,
            apiKeyInfo: apiKeyInfoForCompletion,
            source,
            startTime,
            endpoint: event.rawPath || '/api/ai/v1/completions',
            method: event.requestContext?.http?.method || 'POST',
            finalInputTokens,
            finalOutputTokens,
            hasToolCalls,
            db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
            logger,
          });

          // 9. Wait for stream to finish flushing all data
          responseStream.on('finish', () => {
            logger.info('[CLI_LLM] Stream flushed and closed');
            resolve(); // Lambda can now exit safely
          });

          responseStream.on('error', err => {
            logger.error('[CLI_LLM] Stream error:', err);
            reject(err);
          });
        } catch (error) {
          // Handle errors before or during streaming
          logger.error('[CLI_LLM] Handler error:', error);

          // Log failed completion analytics event if we have userId and body (may not be set if error during auth/parsing)
          if (userId && body) {
            await logCompletionAnalytics({
              type: 'failure',
              requestId,
              userId,
              body,
              apiKeyInfo: apiKeyInfoForCompletion,
              source,
              startTime,
              endpoint: event.rawPath || '/api/ai/v1/completions',
              method: event.requestContext?.http?.method || 'POST',
              error,
              db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
              logger,
            });
          }

          try {
            const errorEvent = formatSSEError(error, requestId);
            responseStream.write(serializeSSEEvent(errorEvent));
            responseStream.end();
          } catch (streamError) {
            logger.error('[CLI_LLM] Failed to write error to stream:', streamError);
          }

          reject(error);
        } finally {
          clearInterval(heartbeat);
        }
      })().catch(reject); // Close IIFE and handle any uncaught errors
    });
  }
);
