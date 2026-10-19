import { createCompletionCreditHolds } from '@server/billing/completionCreditHolds';
import express, { type Request, type Response, type Express, type NextFunction } from 'express';
import {
  CompletionRequestSchema,
  HTTPError,
  LEGACY_REQUEST_ID_HEADER,
  REQUEST_ID_HEADER,
  TooManyRequestsError,
  UnauthorizedError,
  UnprocessableEntityError,
  buildMetaEvent,
  buildCompletionStreamEvent,
  createCompletionContract,
  formatSSEError,
  normalizeCompletionRequest,
  resolveApiCompletionSource,
  resolveRequestClient,
  resolveRequestId,
  serializeSSEEvent,
  SSE_DONE_SIGNAL,
  SSE_KEEPALIVE,
  type CompletionSource,
  type CompletionSseErrorCode,
  type SSEErrorEvent,
  type TurnUsage,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { executeCompletion } from '@bike4mind/services/cliCompletions';
import { resolveQuestErrorCode } from '@bike4mind/services/llm';
import { getHttpStatus, isSafetyRefusalError } from '@bike4mind/utils';
import {
  connectDB,
  mongoose,
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  userRepository,
  userApiKeyRepository,
  usageEventRepository,
  organizationRepository,
} from '@bike4mind/database';
import { checkRateLimit, checkApiKeyRateLimitOrThrow, type ApiKeyInfo } from '@server/cli/auth';
import { resolveContractAuth } from '@server/cli/resolveContractAuth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { Config } from '@server/utils/config';
import { flattenHeaders } from '@server/utils/flattenHeaders';
import { serializeError } from '@server/utils/serializeError';
import { createMethodGuard } from '@server/utils/allowedMethods';
import { buildErrorBody, httpErrorToResponse } from '@server/middlewares/errorHandler';
import { emitProcessingFailed } from '../processingFailedMetric';
import { fromZodError } from 'zod-validation-error';
import { z } from 'zod';
import { COMPLETION_TIMING_ENABLED, classifyChunk, createCompletionTiming } from './completionTiming';

/**
 * Public CLI/3rd-party completions endpoint (`/api/ai/v1/completions`), served by the always-on
 * ChatCompletion service (Fargate). This is the sole implementation - it replaced the former
 * `cliLlmHandler` Lambda, which has been removed; the public path/version (`v1`) is unchanged, so
 * existing clients need no change. User auth (API key or JWT - NOT the shared-secret `/process`
 * gate), OpenAI-ish SSE wire contract, request schema, and analytics all match what the Lambda did.
 *
 * Why the always-on service: no cold start, and no 15-minute Lambda ceiling on the steady-state
 * path (a long stream is bounded only by client/idle limits, not a hard function timeout).
 * Trade-off: a deploy/scale-in SIGTERM drains for up to DRAIN_TIMEOUT_MS (server.ts) before
 * SIGKILL, so a completion still streaming across a deploy is cut off - the old Lambda
 * allowed up to 15 minutes regardless.
 *
 * Every failure found before the provider call is a JSON error with its own status; the 200 and
 * the SSE stream are committed only in executeCompletion's onReady.
 */

const COMPLETIONS_ENDPOINT = '/api/ai/v1/completions';
const checkCompletionsMethod = createMethodGuard([createCompletionContract.method]);

// Periodic SSE comment so an intermediary (CloudFront / socket layer) doesn't close the
// connection during a token-less gap (e.g. extended thinking). Matches the v1 cadence.
const HEARTBEAT_INTERVAL_MS = 10_000;

function requestIdFrom(headers: Record<string, string | undefined>): string {
  return resolveRequestId(headers[REQUEST_ID_HEADER.toLowerCase()], headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]);
}

/** A failure caught before onReady: the JSON envelope, with the status its thrower chose. */
function toJsonError(
  error: unknown,
  requestId: string
): { status: number; headers: Record<string, string>; body: Record<string, unknown> } {
  const questCode = resolveQuestErrorCode(error);
  if (questCode) {
    const message = error instanceof Error ? error.message : 'Insufficient credits';
    return httpErrorToResponse(new UnprocessableEntityError(message, { errorCode: questCode }), requestId);
  }
  if (error instanceof HTTPError) return httpErrorToResponse(error, requestId);
  return { status: 500, headers: {}, body: buildErrorBody({ error: 'Internal error', requestId }) };
}

/** A failure after onReady: a typed in-band frame that never carries the raw upstream body. */
function toStreamErrorFrame(error: unknown, requestId: string): SSEErrorEvent {
  const questCode = resolveQuestErrorCode(error);
  let frameError: unknown = error;
  let code: CompletionSseErrorCode | undefined = questCode;
  if (!questCode) {
    const status = error instanceof Error ? getHttpStatus(error) : undefined;
    // A refusal is deterministic: retrying the same prompt gets the same answer, unlike provider_error.
    if (error instanceof Error && isSafetyRefusalError(error)) {
      frameError = new Error('The model declined this request');
      code = 'content_blocked';
    } else if (status === 401 || status === 403) {
      frameError = new Error(
        status === 401 ? 'Model provider rejected our credentials' : 'Model provider denied access to this model'
      );
      code = 'provider_rejected';
    } else {
      const upstream = status === undefined ? '' : ` (upstream ${status})`;
      frameError = new Error(`Model provider returned an error${upstream}`);
      code = 'provider_error';
    }
  }
  return formatSSEError(frameError, requestId, code);
}

/**
 * express.json failures never reach the handler. 415 (unsupported charset or encoding) is outside
 * the contract's status table, so every client fault but an oversized body folds into 400.
 */
function handleBodyParserError(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  const requestId = requestIdFrom(flattenHeaders(req.headers));
  const parserStatus = err instanceof Error ? getHttpStatus(err) : undefined;
  if (parserStatus === undefined || parserStatus < 400 || parserStatus >= 500) {
    new Logger({ metadata: { service: 'chatCompletion', endpoint: COMPLETIONS_ENDPOINT, requestId } }).error(
      '[CLI_LLM] Body parser error',
      { requestId, error: serializeError(err) }
    );
    res
      .status(500)
      .set(REQUEST_ID_HEADER, requestId)
      .json(buildErrorBody({ error: 'Internal error', requestId }));
    return;
  }
  const type = (err as { type?: unknown }).type;
  const status = type === 'entity.too.large' ? 413 : 400;
  const message = err instanceof Error && err.message ? err.message : 'Invalid request body';
  res
    .status(status)
    .set(REQUEST_ID_HEADER, requestId)
    .json(buildErrorBody({ error: message, requestId }));
}

/**
 * Register `POST /api/ai/v1/completions` on the ChatCompletion Express app.
 *
 * @param track - registers the request's completion promise with the service's SIGTERM
 *   drain set, so an in-flight stream finishes (bounded by DRAIN_TIMEOUT_MS) before exit.
 */
export function registerExternalRoutes(app: Express, track: (p: Promise<void>) => void): void {
  app.post(COMPLETIONS_ENDPOINT, express.json({ limit: '25mb' }), async (req: Request, res: Response) => {
    // Resolve when the response finishes or the client disconnects - tracked for drain.
    const done = new Promise<void>(resolve => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
    track(done);

    const startTime = Date.now();
    const timing = COMPLETION_TIMING_ENABLED ? createCompletionTiming() : undefined;
    const headers = flattenHeaders(req.headers);
    const logger = new Logger({ metadata: { service: 'chatCompletion', endpoint: COMPLETIONS_ENDPOINT } });

    // Correlation ID - accept the caller's value (sanitized) or generate one.
    const requestId = requestIdFrom(headers);
    logger.updateMetadata({ requestId });
    res.setHeader(REQUEST_ID_HEADER, requestId);

    // Distinguish CLI and Desktop from 3rd-party API by the `b4m-cli/` / `b4m-desktop/` client signal.
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

    // Headers stay unsent until the provider call, so earlier failures can still answer with a JSON status.
    let heartbeat: NodeJS.Timeout | undefined;
    const onReady = () => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      write(SSE_KEEPALIVE);
      write(serializeSSEEvent(buildMetaEvent(requestId)));
      heartbeat = setInterval(() => write(SSE_KEEPALIVE), HEARTBEAT_INTERVAL_MS);
    };

    let body: z.infer<typeof CompletionRequestSchema> | undefined;
    let userId: string | undefined;
    let apiKeyInfo: ApiKeyInfo | undefined;
    let apiKeyInfoForCompletion: { keyId: string; keyName: string } | undefined;

    try {
      // The service connects at boot in the background; a request can land first.
      if (mongoose.connection.readyState !== 1) {
        try {
          await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
        } catch (dbError) {
          logger.error('[CLI_LLM] Database connect failed', { requestId, error: serializeError(dbError) });
          throw new HTTPError(503, 'Service temporarily unavailable. Retry shortly.');
        }
      }

      const parsed = CompletionRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new UnprocessableEntityError(fromZodError(parsed.error).message);
      body = normalizeCompletionRequest(parsed.data);

      let authResult;
      try {
        authResult = await resolveContractAuth(headers, createCompletionContract);
      } catch (authError) {
        logger.warn('[CLI_LLM] Authentication failed', { requestId, error: serializeError(authError) });
        // verifyApiKey and verifyJwtToken throw plain Errors for a missing or invalid credential.
        throw authError instanceof HTTPError
          ? authError
          : new UnauthorizedError('Authentication failed. Provide a valid API key or JWT token.');
      }
      userId = authResult.userId;
      timing?.phase('authed');

      if (authResult.method === 'apiKey') {
        apiKeyInfo = authResult.apiKeyInfo;
        logger.info('[CLI_LLM] Authenticated via API key', { keyId: apiKeyInfo.keyId });
        await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
          userId: apiKeyInfo.userId,
          endpoint: COMPLETIONS_ENDPOINT,
          method: req.method,
        });
      } else {
        logger.info('[CLI_LLM] Authenticated via JWT', { userId });
        await checkRateLimit(userId, source, { client: resolveRequestClient(headers) });
      }

      timing?.phase('rateLimited');
      logger.updateMetadata({ userId, model: body.model, apiKeyId: apiKeyInfo?.keyId });
      logger.info(`[CLI_LLM] Starting completion for user ${userId}, model: ${body.model}`, {
        authMethod: apiKeyInfo ? 'api_key' : 'jwt',
      });

      // Resolve API key name for credit attribution.
      if (apiKeyInfo) {
        const userApiKey = await userApiKeyRepository.findById(apiKeyInfo.keyId);
        if (userApiKey) {
          apiKeyInfoForCompletion = { keyId: userApiKey.id, keyName: userApiKey.name };
        }
      }

      // Stream the completion, tracking usage for analytics.
      let finalInputTokens = 0;
      let finalOutputTokens = 0;
      let finalCacheReadTokens = 0;
      let finalCacheWriteTokens = 0;
      let finalTurnUsage: TurnUsage[] | undefined;
      let hasToolCalls = false;

      timing?.phase('completionStarted');
      await executeCompletion({
        creditHolds: createCompletionCreditHolds(logger),
        userId,
        model: body.model,
        messages: body.messages,
        options: body.options,
        db: {
          adminSettings: adminSettingsRepository,
          apiKeys: apiKeyRepository,
          creditTransactions: creditTransactionRepository,
          users: userRepository,
          // Required for the UsageEvent dual-write (executeCompletion does
          // `db.usageEvents?.record(...)` - optional-chained, so omitting this silently drops
          // billing/usage analytics for the public completions path, as the old Lambda did NOT).
          usageEvents: usageEventRepository,
          // Required to reserve/settle against an org pool for org-billed API keys.
          organizations: organizationRepository,
        },
        apiKeyInfo: apiKeyInfoForCompletion,
        // Org-billed API keys route spend to the org's shared pool (invariant:
        // organizationId is set iff the key's billingOwnerType is Organization).
        billingOrganizationId: apiKeyInfo?.organizationId,
        // Correlation id for the usage-event dual write (synthesized downstream if absent).
        requestId,
        source,
        logger,
        onReady,
        onChunk: async (text, info) => {
          if (info?.inputTokens) finalInputTokens = info.inputTokens;
          if (info?.outputTokens) finalOutputTokens = info.outputTokens;
          if (info?.cacheReadInputTokens) finalCacheReadTokens = info.cacheReadInputTokens;
          if (info?.cacheCreationInputTokens) finalCacheWriteTokens = info.cacheCreationInputTokens;
          if (info?.turnUsage?.length) finalTurnUsage = info.turnUsage;
          if (info?.toolsUsed && info.toolsUsed.length > 0) hasToolCalls = true;
          timing?.chunk(classifyChunk(text, info));
          write(serializeSSEEvent(buildCompletionStreamEvent(text, info)));
        },
      });

      // Close the stream and log success analytics.
      write(SSE_DONE_SIGNAL);
      end();
      if (heartbeat) clearInterval(heartbeat);
      logger.info('[CLI_LLM] Completion stream finished successfully');

      await logCompletionAnalytics({
        type: 'success',
        requestId,
        userId,
        body,
        apiKeyInfo: apiKeyInfoForCompletion,
        source,
        startTime,
        endpoint: COMPLETIONS_ENDPOINT,
        method: req.method,
        finalInputTokens,
        finalOutputTokens,
        finalCacheReadTokens,
        finalCacheWriteTokens,
        finalTurnUsage,
        hasToolCalls,
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        logger,
      });
    } catch (error) {
      const jsonError = toJsonError(error, requestId);
      const level = jsonError.status < 500 ? 'warn' : 'error';
      const upstreamStatus = error instanceof Error ? getHttpStatus(error) : undefined;
      logger[level]('[CLI_LLM] Handler error', { requestId, upstreamStatus, error: serializeError(error) });
      track(emitProcessingFailed('cli-sse', error));

      try {
        if (res.headersSent) {
          write(serializeSSEEvent(toStreamErrorFrame(error, requestId)));
          end();
          if (heartbeat) clearInterval(heartbeat);
        } else {
          res.status(jsonError.status).set(jsonError.headers).json(jsonError.body);
        }
      } catch (responseError) {
        logger.error('[CLI_LLM] Failed to write error response', { requestId, error: serializeError(responseError) });
      }

      // After the response so a slow analytics write cannot delay it.
      if (userId && body && !(error instanceof TooManyRequestsError)) {
        await logCompletionAnalytics({
          type: 'failure',
          requestId,
          userId,
          body,
          apiKeyInfo: apiKeyInfoForCompletion,
          source,
          startTime,
          endpoint: COMPLETIONS_ENDPOINT,
          method: req.method,
          error,
          db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
          logger,
        }).catch(analyticsError =>
          logger.warn('[CLI_LLM] Failure analytics write failed', { requestId, error: serializeError(analyticsError) })
        );
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (timing) logger.info('[CLI_TIMING] completion phases', timing.summary());
    }
  });
  app.use(COMPLETIONS_ENDPOINT, handleBodyParserError);

  // Express answers an unregistered verb with a bare 404, but the contract documents a 405 with
  // `Allow` (openapi/registerContract.ts) - the same one baseApi and defineLambdaRoute serve.
  app.all(COMPLETIONS_ENDPOINT, (req: Request, res: Response, next: NextFunction) => {
    const result = checkCompletionsMethod(req.method);
    if (result.allowed) return next();
    const requestId = requestIdFrom(flattenHeaders(req.headers));
    res
      .status(405)
      .set({ Allow: result.allowHeader, [REQUEST_ID_HEADER]: requestId })
      .json({ error: result.message, request_id: requestId });
  });
}
