import express, { type Request, type Response, type Express } from 'express';
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
import { Logger } from '@bike4mind/observability';
import { executeCompletion } from '@bike4mind/services';
import {
  connectDB,
  mongoose,
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  userRepository,
  userApiKeyRepository,
} from '@bike4mind/database';
import {
  verifyJwtToken,
  checkRateLimit,
  verifyApiKey,
  checkApiKeyRateLimitOrThrow,
  type ApiKeyInfo,
} from '@server/cli/auth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { Config } from '@server/utils/config';
import { z } from 'zod';

/**
 * v2 CLI/3rd-party completions - served by the always-on QuestProcessorService (Fargate)
 * instead of the v1 `cliLlmHandler` Lambda. Same wire contract (OpenAI-ish SSE), same auth
 * (user API key or JWT - NOT the shared-secret `/process` gate), same request schema and
 * analytics. The only difference from v1 is the transport: Express `res` streaming here vs
 * Lambda response streaming there. v1 is kept alongside for A/B comparison and to serve
 * existing clients; once v2 is validated the shared orchestration can be unified.
 *
 * Why Fargate: no cold start and no 15-minute Lambda ceiling on the steady-state path.
 * Trade-off inherited from the service: a deploy/scale-in SIGTERM drains for up to 120s
 * (DRAIN_TIMEOUT_MS in server.ts) before SIGKILL, so a completion still streaming past that
 * window is cut off - the v1 Lambda allowed up to 15 minutes.
 */

const V2_ENDPOINT = '/api/ai/v2/completions';

// Periodic SSE comment so an intermediary (CloudFront / socket layer) doesn't close the
// connection during a token-less gap (e.g. extended thinking). Matches the v1 cadence.
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Express headers are `string | string[] | undefined`; the auth/source helpers want a flat
 * `Record<string, string | undefined>`. Lowercase keys and take the first value of any array.
 */
function flattenHeaders(headers: Request['headers']): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return flat;
}

/**
 * Register `POST /api/ai/v2/completions` on the QuestProcessorService Express app.
 *
 * @param track - registers the request's completion promise with the service's SIGTERM
 *   drain set, so an in-flight stream finishes (bounded by DRAIN_TIMEOUT_MS) before exit.
 */
export function registerCompletionsV2Route(app: Express, track: (p: Promise<void>) => void): void {
  app.post(V2_ENDPOINT, express.json({ limit: '25mb' }), async (req: Request, res: Response) => {
    // Resolve when the response finishes or the client disconnects - tracked for drain.
    const done = new Promise<void>(resolve => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
    track(done);

    const startTime = Date.now();
    const headers = flattenHeaders(req.headers);
    const logger = new Logger({ metadata: { service: 'questProcessorService', endpoint: V2_ENDPOINT } });

    // Correlation ID - accept the caller's value (sanitized) or generate one. #8439
    const requestId = resolveRequestId(
      headers[REQUEST_ID_HEADER.toLowerCase()],
      headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
    );
    logger.updateMetadata({ requestId });

    // Distinguish CLI from 3rd-party API by the `b4m-cli/<version>` UA the CLI sets.
    // Used for both the credit transaction and analytics so usage breaks down by surface.
    const source: CompletionSource = resolveApiCompletionSource(headers);

    // Write helpers guard against a closed socket (client disconnect / already-ended stream).
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        res.end();
      }
    };

    // SSE headers, then an immediate keep-alive + meta event to establish the stream before
    // the pre-LLM work (DB connect, auth, rate limiting) can trip an intermediary timeout.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    write(SSE_KEEPALIVE);
    write(serializeSSEEvent(buildMetaEvent(requestId)));

    const heartbeat = setInterval(() => write(SSE_KEEPALIVE), HEARTBEAT_INTERVAL_MS);

    let body: z.infer<typeof CompletionRequestSchema> | undefined;
    let userId: string | undefined;
    let apiKeyInfo: ApiKeyInfo | undefined;
    let apiKeyInfoForCompletion: { keyId: string; keyName: string } | undefined;

    try {
      // 1. Ensure DB connectivity (the service connects at boot in the background, but a
      // request can land before that resolves; connectDB is a no-op if already connected).
      if (mongoose.connection.readyState !== 1) {
        await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
      }

      // 2. Validate request body (already JSON-parsed by express.json above).
      try {
        body = normalizeCompletionRequest(CompletionRequestSchema.parse(req.body));
      } catch {
        write(serializeSSEEvent(formatSSEError(new Error('Invalid request body'), requestId)));
        end();
        return;
      }

      // 3. Authenticate - API key first, then JWT (mirrors v1).
      try {
        apiKeyInfo = await verifyApiKey(headers);
        userId = apiKeyInfo.userId;
        logger.info('[CLI_LLM_V2] Authenticated via API key', { keyId: apiKeyInfo.keyId });

        await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
          userId: apiKeyInfo.userId,
          endpoint: V2_ENDPOINT,
          method: req.method,
        });
      } catch (apiKeyError) {
        // API key path failed (missing/invalid key, or rate limit). If a key was present and
        // valid but rate-limited, surface that rather than falling through to JWT.
        if (apiKeyInfo) {
          write(
            serializeSSEEvent(
              formatSSEError(apiKeyError instanceof Error ? apiKeyError : new Error('Rate limit exceeded'), requestId)
            )
          );
          end();
          return;
        }

        const token = headers.authorization?.replace('Bearer ', '');
        try {
          const user = await verifyJwtToken(token);
          userId = user.id;
          logger.info('[CLI_LLM_V2] Authenticated via JWT', { userId });
          await checkRateLimit(userId, source);
        } catch (jwtError) {
          write(
            serializeSSEEvent(
              formatSSEError(new Error('Authentication failed. Provide a valid API key or JWT token.'), requestId)
            )
          );
          end();
          return;
        }
      }

      logger.updateMetadata({ userId, model: body.model, apiKeyId: apiKeyInfo?.keyId });
      logger.info(`[CLI_LLM_V2] Starting completion for user ${userId}, model: ${body.model}`, {
        authMethod: apiKeyInfo ? 'api_key' : 'jwt',
      });

      // 4. Resolve API key name for credit attribution.
      if (apiKeyInfo) {
        const userApiKey = await userApiKeyRepository.findById(apiKeyInfo.keyId);
        if (userApiKey) {
          apiKeyInfoForCompletion = { keyId: userApiKey.id, keyName: userApiKey.name };
        }
      }

      // 5. Stream the completion, tracking usage for analytics.
      let finalInputTokens = 0;
      let finalOutputTokens = 0;
      let hasToolCalls = false;

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
        },
        apiKeyInfo: apiKeyInfoForCompletion,
        source,
        logger,
        onChunk: async (text, info) => {
          if (info?.inputTokens) finalInputTokens = info.inputTokens;
          if (info?.outputTokens) finalOutputTokens = info.outputTokens;
          if (info?.toolsUsed && info.toolsUsed.length > 0) hasToolCalls = true;
          write(serializeSSEEvent(buildSSEEvent(text, info)));
        },
      });

      // 6. Close the stream and log success analytics.
      write(SSE_DONE_SIGNAL);
      end();
      logger.info('[CLI_LLM_V2] Completion stream finished successfully');

      await logCompletionAnalytics({
        type: 'success',
        requestId,
        userId,
        body,
        apiKeyInfo: apiKeyInfoForCompletion,
        source,
        startTime,
        endpoint: V2_ENDPOINT,
        method: req.method,
        finalInputTokens,
        finalOutputTokens,
        hasToolCalls,
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        logger,
      });
    } catch (error) {
      logger.error('[CLI_LLM_V2] Handler error', { error: error instanceof Error ? error.message : String(error) });

      if (userId && body) {
        await logCompletionAnalytics({
          type: 'failure',
          requestId,
          userId,
          body,
          apiKeyInfo: apiKeyInfoForCompletion,
          source,
          startTime,
          endpoint: V2_ENDPOINT,
          method: req.method,
          error,
          db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
          logger,
        }).catch(() => {}); // analytics failure must not mask the original error
      }

      try {
        write(serializeSSEEvent(formatSSEError(error, requestId)));
        end();
      } catch (streamError) {
        logger.error('[CLI_LLM_V2] Failed to write error to stream', {
          error: streamError instanceof Error ? streamError.message : String(streamError),
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
}
