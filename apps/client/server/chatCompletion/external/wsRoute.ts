import { createCompletionCreditHolds } from '@server/billing/completionCreditHolds';
import { checkFreeTierDailySpendCap } from '@server/billing/freeTierDailyCapGate';
import { actorScopeForKey } from '@server/auth/apiKeyAdminScope';
import express, { type Request, type Response, type Express } from 'express';
import {
  CompletionRequestSchema,
  buildCompletionStreamEvent,
  HTTPError,
  IMessage,
  normalizeCompletionRequest,
  resolveApiCompletionSource,
  resolveRequestClient,
  type CompletionSource,
  type TurnUsage,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { executeCompletion } from '@bike4mind/services/cliCompletions';
import {
  connectDB,
  mongoose,
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  usageEventRepository,
  userRepository,
  userApiKeyRepository,
  organizationRepository,
  cacheRepository,
} from '@bike4mind/database';
import { Connection } from '@bike4mind/database/social';
import {
  verifyJwtToken,
  checkRateLimit,
  verifyApiKey,
  checkApiKeyRateLimitOrThrow,
  type ApiKeyInfo,
} from '@server/cli/auth';
import { logCompletionAnalytics } from '@server/utils/logCompletionAnalytics';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { sendToConnection } from '@server/websocket/utils';
import { isAuthInfraFailure, setAuthInfraFailureHeaders } from '@server/auth/apiKeyAuthFailure';
import { Config } from '@bike4mind/server-utils/utils/config';
import { cliCompletionErrorFields, sanitizeErrorMessage } from '@server/utils/errorSanitization';
import { emitProcessingFailed } from '../processingFailedMetric';
import { Resource } from 'sst';
import { z } from 'zod';
import { getUserEntitlements } from '@server/entitlements';
import { httpErrorToResponse } from '@server/middlewares/errorHandler';
import {
  admitApiKeyCompletion,
  NO_COMPLETION_QUOTA,
  type CompletionQuotaGrant,
} from '@server/utils/untrustedCompletionQuota';
import { logApiKeyUsageOnResponse } from './apiKeyUsageLog';
import { resolveThinkingVisibility } from '@server/utils/thinkingVisibility';

/**
 * CLI completions with WebSocket response streaming (`/api/ai/v1/ws-completions`), served by
 * the always-on ChatCompletion service. This replaced the former `CliWsCompletionHandler`
 * Lambda (apps/client/server/cli/wsCompletions.ts), which has been removed.
 *
 * The CLI sends the full request payload via HTTP POST (no 32KB WebSocket frame limit) and
 * receives streaming chunks via its existing WebSocket connection:
 *  1. CLI registers a WebSocket handler for `requestId`
 *  2. CLI POSTs here with { requestId, model, messages, options }
 *  3. We validate + authenticate, respond 202, and run the completion in the background,
 *     streaming chunks via sendToConnection
 *
 * The early 202 is what lets this route sit behind CloudFront (the Lambda held the response
 * open for the whole completion, forcing a direct function URL to dodge the origin read
 * timeout). The CLI never reads the response body - chunks, completion, and errors all
 * arrive over the WebSocket (cli_completion_chunk / _done / _error) - so only pre-completion
 * failures (bad request, auth, no connection) surface as HTTP errors.
 */

const WS_COMPLETIONS_ENDPOINT = '/api/ai/v1/ws-completions';

const WsCompletionRequestSchema = CompletionRequestSchema.extend({
  requestId: z.uuid(),
  connectionId: z.string().optional(),
});

/**
 * Express headers are `string | string[] | undefined`; the auth helpers want a flat
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
 * Register `POST /api/ai/v1/ws-completions` on the ChatCompletion Express app.
 *
 * @param track - registers the background completion promise with the service's SIGTERM
 *   drain set, so an in-flight stream finishes (bounded by DRAIN_TIMEOUT_MS) before exit.
 */
export function registerWsCompletionRoutes(app: Express, track: (p: Promise<void>) => void): void {
  app.post(WS_COMPLETIONS_ENDPOINT, express.json({ limit: '25mb' }), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const headers = flattenHeaders(req.headers);
    const logger = new Logger({ metadata: { service: 'chatCompletion', endpoint: WS_COMPLETIONS_ENDPOINT } });

    // Preserve the legacy WS source except for an explicitly identified Desktop caller.
    const source: CompletionSource = resolveApiCompletionSource(headers) === 'desktop' ? 'desktop' : 'cli';

    let body: z.infer<typeof WsCompletionRequestSchema>;
    let userId: string;
    let apiKeyInfo: ApiKeyInfo | undefined;

    // ── Synchronous phase: validate + authenticate, then 202. Failures here are the only
    // ones the CLI sees as HTTP errors; everything after streams over the WebSocket. ──
    try {
      if (mongoose.connection.readyState !== 1) {
        await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
      }

      try {
        body = normalizeCompletionRequest(WsCompletionRequestSchema.parse(req.body));
      } catch {
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }

      // Authenticate - API key first, then JWT (mirrors the SSE route).
      try {
        apiKeyInfo = await verifyApiKey(headers);
        userId = apiKeyInfo.userId;
        logger.info('[CLI_WS_HTTP] Authenticated via API key', { keyId: apiKeyInfo.keyId });
        logApiKeyUsageOnResponse({
          req,
          res,
          apiKey: apiKeyInfo,
          endpoint: WS_COMPLETIONS_ENDPOINT,
          source,
          startTime,
          logger,
          track,
        });

        await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
          userId: apiKeyInfo.userId,
          endpoint: WS_COMPLETIONS_ENDPOINT,
          method: req.method,
        });
      } catch (apiKeyError) {
        // The key check itself failed (database unreachable): retryable, not a bad credential.
        if (isAuthInfraFailure(apiKeyError)) {
          setAuthInfraFailureHeaders(res, apiKeyError);
          res.status(apiKeyError.statusCode).json({ error: apiKeyError.message });
          return;
        }
        // A present-but-rate-limited key surfaces its error rather than falling through to JWT.
        if (apiKeyInfo) {
          res.status(429).json({ error: sanitizeErrorMessage(apiKeyError) });
          return;
        }
        const token = headers.authorization?.replace('Bearer ', '');
        try {
          const user = await verifyJwtToken(token, { requireApiAccess: true });
          userId = user.id;
          logger.info('[CLI_WS_HTTP] Authenticated via JWT', { userId });
          await checkRateLimit(userId, source, { client: resolveRequestClient(headers) });
        } catch (authError) {
          // verifyJwtToken refuses an authenticated session for reasons the caller can act on
          // (MFA enrollment, account dispute or suspension) with a ForbiddenError; relaying it as
          // 401 makes the CLI report an expired session and tell the user to sign in again, which
          // cannot help.
          // The message is server-authored guidance (sanitizeErrorMessage would blank it).
          if (isAuthInfraFailure(authError)) {
            setAuthInfraFailureHeaders(res, authError);
            res.status(authError.statusCode).json({ error: authError.message });
            return;
          }
          if (authError instanceof ForbiddenError) {
            res.status(403).json({ error: authError.message });
            return;
          }
          res.status(401).json({ error: 'Authentication failed' });
          return;
        }
      }
    } catch (error) {
      logger.error('[CLI_WS_HTTP] Pre-completion error', {
        error: error instanceof Error ? error.message : String(error),
      });
      track(emitProcessingFailed('cli-ws', error));
      res.status(500).json({ error: sanitizeErrorMessage(error) });
      return;
    }

    const { requestId, model, messages, options, sessionId } = body;
    logger.updateMetadata({ userId, model, requestId });

    // The CLI must already hold a WebSocket connection to receive the stream.
    const connections = await Connection.find({ userId });
    if (connections.length === 0) {
      res.status(400).json({ error: 'No active WebSocket connection found' });
      return;
    }

    // Prefer the requesting CLI's connection; fall back to all of the user's connections
    // (e.g. the CLI reconnected with a new connectionId between register and POST).
    const targetConnections = body.connectionId
      ? connections.filter(conn => conn.connectionId === body.connectionId)
      : connections;
    const effectiveConnections = targetConnections.length > 0 ? targetConnections : connections;

    const wsEndpoint = Resource.websocket.managementEndpoint;
    const sendToConnections = async (data: Record<string, unknown>): Promise<void> => {
      await Promise.allSettled(
        effectiveConnections.map(conn => sendToConnection(conn.connectionId, wsEndpoint, data as never))
      );
    };

    // Last check before the 202, so every refusal is still an HTTP status the CLI can read.
    let quota: CompletionQuotaGrant = NO_COMPLETION_QUOTA;
    if (apiKeyInfo) {
      try {
        quota = await admitApiKeyCompletion({
          owner: userId,
          ownerUntrusted: apiKeyInfo.ownerUntrusted,
          billingOwnerType: apiKeyInfo.billingOwnerType,
          holdSlot: true,
        });
      } catch (error) {
        if (!(error instanceof HTTPError)) {
          logger.error('[CLI_WS_HTTP] Quota check failed', { error: sanitizeErrorMessage(error) });
          res.status(500).json({ error: sanitizeErrorMessage(error) });
          return;
        }
        const { status, headers, body: errorBody } = httpErrorToResponse(error, undefined);
        res.status(status).set(headers).json(errorBody);
        return;
      }
    }

    logger.info(`[CLI_WS_HTTP] Starting completion for user ${userId}, model: ${model}`);
    res.status(202).json({ success: true });

    // ── Background phase: run the completion and stream over the WebSocket. Tracked so a
    // deploy's SIGTERM drains it (bounded by DRAIN_TIMEOUT_MS in server.ts). ──
    track(
      (async () => {
        let apiKeyInfoForCompletion: { keyId: string; keyName: string } | undefined;
        let finalInputTokens = 0;
        let finalOutputTokens = 0;
        let finalCacheReadTokens = 0;
        let finalCacheWriteTokens = 0;
        let finalTurnUsage: TurnUsage[] | undefined;
        let finalCreditsUsed: number | undefined;
        let hasToolCalls = false;

        try {
          // Resolve API key name for credit attribution / analytics.
          if (apiKeyInfo) {
            const key = await userApiKeyRepository.findById(apiKeyInfo.keyId);
            if (key) {
              apiKeyInfoForCompletion = { keyId: key.id, keyName: key.name };
            }
          }

          // Daily spend cap before the credit hold; applies to all free-tier users regardless of auth method.
          await checkFreeTierDailySpendCap({
            userId,
            userRepository,
            billingOrganizationId: apiKeyInfo?.organizationId,
            usageEventRepository,
            logger,
          });

          // Cast: Zod parses content/tools as unknown[], but executeCompletion expects typed arrays
          await executeCompletion({
            getEntitlements: getUserEntitlements,
            getThinkingVisibility: resolveThinkingVisibility,
            creditHolds: createCompletionCreditHolds(logger),
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
              cache: cacheRepository,
            },
            apiKeyInfo: apiKeyInfoForCompletion,
            scopeActor: actorScopeForKey(apiKeyInfo),
            // Org-billed API keys settle to the org's shared pool.
            billingOrganizationId: apiKeyInfo?.organizationId,
            requestId,
            source,
            sessionId,
            logger,
            onChunk: async (text, info) => {
              if (info?.inputTokens) finalInputTokens = info.inputTokens;
              if (info?.outputTokens) finalOutputTokens = info.outputTokens;
              if (info?.cacheReadInputTokens) finalCacheReadTokens = info.cacheReadInputTokens;
              if (info?.cacheCreationInputTokens) finalCacheWriteTokens = info.cacheCreationInputTokens;
              if (info?.turnUsage?.length) finalTurnUsage = info.turnUsage;
              if (typeof info?.creditsUsed === 'number') finalCreditsUsed = info.creditsUsed;
              if (info?.toolsUsed && info.toolsUsed.length > 0) hasToolCalls = true;

              const chunk = buildCompletionStreamEvent(text, info);
              await sendToConnections({
                action: 'cli_completion_chunk' as const,
                requestId,
                chunk,
              });
            },
          });

          await sendToConnections({
            action: 'cli_completion_done' as const,
            requestId,
          });
          logger.info('[CLI_WS_HTTP] Completion stream finished successfully');

          await logCompletionAnalytics({
            type: 'success',
            requestId,
            userId,
            body: { model, messages, options },
            apiKeyInfo: apiKeyInfoForCompletion,
            source,
            startTime,
            endpoint: 'ws-completions',
            method: 'POST',
            finalInputTokens,
            finalOutputTokens,
            finalCacheReadTokens,
            finalCacheWriteTokens,
            finalTurnUsage,
            finalCreditsUsed,
            hasToolCalls,
            db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
            logger,
          });
        } catch (error) {
          const level = error instanceof HTTPError && error.statusCode < 500 ? 'warn' : 'error';
          logger[level]('[CLI_WS_HTTP] Completion error:', error);
          track(emitProcessingFailed('cli-ws', error));

          // The 202 is long gone - the error must reach the CLI over the WebSocket.
          try {
            await sendToConnections({
              action: 'cli_completion_error' as const,
              requestId,
              ...cliCompletionErrorFields(error),
            });
          } catch {
            // Best effort
          }

          await logCompletionAnalytics({
            type: 'failure',
            requestId,
            userId,
            body: { model, messages, options },
            apiKeyInfo: apiKeyInfoForCompletion,
            source,
            startTime,
            endpoint: 'ws-completions',
            method: 'POST',
            error,
            db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
            logger,
          }).catch(() => {}); // analytics failure must not mask the original error
        } finally {
          await quota.release();
        }
      })()
    );
  });
}
