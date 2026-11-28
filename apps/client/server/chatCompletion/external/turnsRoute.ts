import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import {
  DEFAULT_SESSION_TURN_HISTORY_COUNT,
  NotFoundError,
  REQUEST_ID_HEADER,
  SSE_DONE_SIGNAL,
  SSE_KEEPALIVE,
  SessionTurnRequestSchema,
  HTTPError,
  UnauthorizedError,
  UnprocessableEntityError,
  buildMetaEvent,
  createSessionTurnContract,
  formatSSEError,
  formatZodError,
  resolveApiCompletionSource,
  resolveRequestClient,
  serializeSessionTurnEvent,
  type IUserDocument,
  type SessionTurnRequest,
  type SessionTurnStreamEvent,
} from '@bike4mind/common';
import {
  User,
  connectDB,
  mongoose,
  questRepository,
  spendFreezeRepository,
  usageEventRepository,
  userRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { assertSpendNotFrozen } from '@bike4mind/services/creditService';
import { ChatCompletionInvoke } from '@bike4mind/services/llm/ChatCompletionInvoke';
import type { QuestStartBodySchema } from '@bike4mind/services/llm';
import { ClientMessageSender, SQSService } from '@bike4mind/utils';
import defineAbilityFor from '@bike4mind/server-utils/auth/ability';
import { resolveRoleAdminPermissions } from '@bike4mind/server-utils/auth/adminRoles';
import {
  adminRoleWithheldFor,
  apiKeyGrantsAdmin,
  withholdAdminRole,
} from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { requestTurnAuth } from '@bike4mind/server-utils/auth/turnAuth';
import { checkFreeTierDailySpendCap } from '@bike4mind/server-utils/billing/freeTierDailyCapGate';
import { spendFreezeSubjectForRequest } from '@bike4mind/server-utils/billing/spendFreezeSubject';
import { checkApiKeyRateLimitOrThrow, checkRateLimit, type ApiKeyInfo } from '@bike4mind/server-utils/cli/auth';
import { resolveContractAuth } from '@bike4mind/server-utils/cli/resolveContractAuth';
import { apiKeyToolsDeniedFor } from '@bike4mind/server-utils/dataLakes/dataLakeScopes';
import { fileInputsAllowedFor } from '@bike4mind/server-utils/files/fileScopes';
import { premiumLlmTools } from '@bike4mind/server-utils/premium-generated/premiumLlmTools.generated';
import { getOrCreateSession } from '@bike4mind/server-utils/managers/sessionManager';
import { checkClientVersion } from '@bike4mind/server-utils/middlewares/clientVersionGate';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { premiumLlmTools } from '@bike4mind/server-utils/premium-generated/premiumLlmTools.generated';
import { createMethodGuard } from '@bike4mind/server-utils/utils/allowedMethods';
import {
  getDefaultChatCompletionOptions,
  getSharedTokenizer,
} from '@bike4mind/server-utils/utils/chatCompletionDefaults';
import { Config } from '@bike4mind/server-utils/utils/config';
import { flattenHeaders } from '@bike4mind/server-utils/utils/flattenHeaders';
import { serializeError } from '@bike4mind/server-utils/utils/serializeError';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { sessionWillInjectAuthoredPrompt } from '@bike4mind/server-utils/utils/sessionSystemPromptResolver';
import { loadBaseIdentitySystemPromptMessages } from '@bike4mind/server-utils/utils/systemPrompts/loader';
import {
  NO_COMPLETION_QUOTA,
  admitRequestCompletion,
  type CompletionQuotaGrant,
} from '@bike4mind/server-utils/utils/untrustedCompletionQuota';
import { resolveRequestBillingOrgId } from '@server/billing/apiKeyBillingOrg';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import { getStaticOptions, processQuest } from '@server/queueHandlers/questProcessor';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { z } from 'zod';
import { handleQuestProcessingFailure } from '../internal/route';
import { logApiKeyUsageOnResponse } from './apiKeyUsageLog';
import { bodyParserErrorHandler, requestIdFrom, toJsonError } from './preStreamErrors';
import { TurnReplyDiffer, createTurnFrameTee, type QuestSnapshot } from './turnFrameStream';

/**
 * Public `POST /api/v1/turns` (sessionTurns.contract.ts): adds a turn to an existing session through
 * the web composer's pipeline (the same gates as /api/ai/llm, then ChatCompletionInvoke) and runs the
 * quest in this process, teeing its websocket frames into an SSE stream for the caller. The web app
 * and other devices still get every frame over the websocket.
 *
 * Every gate runs before the first SSE byte so a rejection is a JSON error with its real status. A
 * client disconnect detaches: the quest is not aborted and runs to the end under track(), exactly
 * as a web send does when its tab closes.
 */

export const TURNS_ENDPOINT = createSessionTurnContract.path;
const checkTurnsMethod = createMethodGuard([createSessionTurnContract.method]);
const HEARTBEAT_INTERVAL_MS = 10_000;
const USER_TIER_RATE_LIMIT_WINDOW_MS = 60 * 1000;

type QuestStartParams = z.infer<typeof QuestStartBodySchema>;

/** The authenticated caller, shaped like the request fields the shared gates read off a Next request. */
type TurnCaller = {
  user: IUserDocument;
  apiKeyInfo?: ApiKeyInfo;
  logger: Logger;
};

/**
 * The caller's user document, prepared as apiKeyAuth prepares `req.user`: an API key without the
 * admin scope does not carry its owner's admin role into the session lookup or the turn.
 */
async function loadKeyOwner(apiKeyInfo: ApiKeyInfo): Promise<IUserDocument> {
  const user = await User.findById(apiKeyInfo.userId);
  if (!user) throw new UnauthorizedError('User not found or banned');
  await resolveRoleAdminPermissions(user);
  return apiKeyGrantsAdmin(apiKeyInfo.scopes) ? user : withholdAdminRole(user);
}

/**
 * The per-user tier limit /api/ai/llm applies through its rateLimit middleware: same resolver, same
 * one-minute window and `rate-limit:<userId>:<path>` bucket. Throws its TooManyRequestsError, with
 * `Retry-After` already set on the response.
 */
function applyUserTierRateLimit(req: Request, res: Response, user: IUserDocument): Promise<void> {
  const limiter = rateLimit({
    limit: () => resolveUserRateLimitPerMin(user),
    windowMs: USER_TIER_RATE_LIMIT_WINDOW_MS,
    bucket: TURNS_ENDPOINT,
    subject: () => user.id,
  });
  return new Promise((resolve, reject) => {
    Promise.resolve(limiter(req, res, error => (error ? reject(error) : resolve()))).catch(reject);
  });
}

/** The invoke body for a validated request: snake_case wire fields onto the composer's camelCase params. */
function toInvokeBody(body: SessionTurnRequest, sessionId: string) {
  return {
    sessionId,
    message: body.message,
    historyCount: body.history_count ?? DEFAULT_SESSION_TURN_HISTORY_COUNT,
    fabFileIds: body.fab_file_ids ?? [],
    messageFileIds: body.message_file_ids ?? [],
    params: {
      model: body.model,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
      ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
      ...(body.thinking ? { thinking: body.thinking } : {}),
    },
    ...(body.prompt_mode ? { promptMode: body.prompt_mode } : {}),
    ...(body.client_submitted_at !== undefined ? { clientSubmittedAt: body.client_submitted_at } : {}),
  };
}

async function storedSnapshot(questId: string): Promise<QuestSnapshot | null> {
  const quest = await questRepository.findById(questId);
  if (!quest) return null;
  return {
    id: questId,
    status: quest.status,
    type: quest.type,
    reply: quest.reply,
    replies: quest.replies,
    creditsUsed: quest.creditsUsed,
    errorCode: quest.errorCode,
  };
}

/**
 * Register `POST /api/v1/turns` on the ChatCompletion Express app.
 *
 * @param track - registers the response and the quest's processing with the service's SIGTERM
 *   drain set, so a turn still running when a deploy starts finishes (bounded by DRAIN_TIMEOUT_MS).
 */
export function registerTurnsRoutes(app: Express, track: (p: Promise<void>) => void): void {
  app.post(TURNS_ENDPOINT, express.json({ limit: '25mb' }), async (req: Request, res: Response) => {
    track(
      new Promise<void>(resolve => {
        res.on('finish', resolve);
        res.on('close', resolve);
      })
    );

    const startTime = Date.now();
    const headers = flattenHeaders(req.headers);
    const requestId = requestIdFrom(headers);
    const logger = new Logger({ metadata: { service: 'chatCompletion', endpoint: TURNS_ENDPOINT, requestId } });
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const source = resolveApiCompletionSource(headers);

    const write = (event: SessionTurnStreamEvent | string) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(typeof event === 'string' ? event : serializeSessionTurnEvent(event));
    };
    let heartbeat: NodeJS.Timeout | undefined;
    let quota: CompletionQuotaGrant = NO_COMPLETION_QUOTA;
    let quotaHandedOff = false;

    try {
      if (mongoose.connection.readyState !== 1) {
        try {
          await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
        } catch (dbError) {
          logger.error('[TURNS] Database connect failed', { error: serializeError(dbError) });
          throw new HTTPError(503, 'Service temporarily unavailable. Retry shortly.');
        }
      }

      const upgradeRequired = await checkClientVersion(req.headers, logger);
      if (upgradeRequired) throw upgradeRequired;

      const parsed = SessionTurnRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new UnprocessableEntityError(formatZodError(parsed.error));
      const body = parsed.data;

      let authResult;
      try {
        authResult = await resolveContractAuth(headers, createSessionTurnContract);
      } catch (authError) {
        logger.warn('[TURNS] Authentication failed', { error: serializeError(authError) });
        throw authError instanceof HTTPError
          ? authError
          : new UnauthorizedError('Authentication failed. Provide a valid API key or JWT token.');
      }

      let caller: TurnCaller;
      if (authResult.method === 'apiKey') {
        const { apiKeyInfo } = authResult;
        await logApiKeyUsageOnResponse({
          req,
          res,
          apiKey: apiKeyInfo,
          endpoint: TURNS_ENDPOINT,
          source,
          startTime,
          logger,
          track,
        });
        await checkApiKeyRateLimitOrThrow(apiKeyInfo, {
          userId: apiKeyInfo.userId,
          endpoint: TURNS_ENDPOINT,
          method: req.method,
        });
        caller = { user: await loadKeyOwner(apiKeyInfo), apiKeyInfo, logger };
      } else {
        await checkRateLimit(authResult.userId, source, { client: resolveRequestClient(headers) });
        caller = { user: authResult.user.user, logger };
      }
      const { user, apiKeyInfo } = caller;
      logger.updateMetadata({ userId: user.id, model: body.model, apiKeyId: apiKeyInfo?.keyId });
      await applyUserTierRateLimit(req, res, user);

      // The same gates, in the same order, as the web composer's /api/ai/llm.
      const billingOrganizationId = await resolveRequestBillingOrgId(caller, body.organization_id);
      assertAiAccessAllowed(user);
      await assertSpendNotFrozen(spendFreezeSubjectForRequest(caller, billingOrganizationId ?? null), {
        db: { spendFreezes: spendFreezeRepository },
      });
      await checkFreeTierDailySpendCap({ user, billingOrganizationId, usageEventRepository, logger });
      // Held until the quest settles: this request runs the work, unlike the queued web send.
      quota = await admitRequestCompletion(caller, { holdSlot: true });
      const fileInputsAllowed = fileInputsAllowedFor(caller);

      // A malformed id is just another session the caller cannot reach, not a cast failure.
      if (!mongoose.isValidObjectId(body.session_id)) throw new NotFoundError('Session not found');
      // With a session id this only looks up (write access via the ability) and never creates.
      const { session, sessionId, asyncPromises } = await getOrCreateSession({
        sessionId: body.session_id,
        fabFileIds: fileInputsAllowed ? body.fab_file_ids : [],
        // An API-key turn keeps its files per-run, as /api/ai/llm does.
        ...(apiKeyInfo ? {} : { messageFileIds: body.message_file_ids }),
        origin: resolveSessionOrigin({ apiKeyInfo, headers: req.headers }),
        user,
        ability: defineAbilityFor(user),
        logger,
      });

      const invokeBody = toInvokeBody(body, sessionId);
      // Same identity rule as /api/ai/llm: a session with its own authored prompt keeps its persona.
      const extraContextMessages = (await sessionWillInjectAuthoredPrompt(session, { user, logger }))
        ? []
        : await loadBaseIdentitySystemPromptMessages(logger);

      let questStartParams: QuestStartParams | undefined;
      const chatCompletion = new ChatCompletionInvoke({
        ...getDefaultChatCompletionOptions(),
        queue: new SQSService(),
        tokenizer: getSharedTokenizer(logger),
        user,
        sessionId,
        logger,
        // Captured, not dispatched: this process runs the quest itself so it can tee the frames.
        invokeLambda: async params => {
          questStartParams = params;
        },
      });

      const deniedTools = apiKeyToolsDeniedFor(caller);
      const quest = await chatCompletion.invoke({
        body: {
          ...invokeBody,
          ...(extraContextMessages.length > 0 ? { extraContextMessages } : {}),
          organizationId: billingOrganizationId,
          ...(deniedTools.length > 0 ? { deniedTools } : {}),
          ...(apiKeyInfo ? { enabledPlatformMcpConnections: undefined } : {}),
        },
        userId: user.id,
        fileInputsAllowed,
        ...requestTurnAuth(caller),
        apiKeyBillingOwnerType: apiKeyInfo?.billingOwnerType,
        oauthClientId: apiKeyInfo?.oauthExchangeClientId,
        adminRoleWithheld: adminRoleWithheldFor(apiKeyInfo),
        contributedToolNames: new Set(Object.keys(premiumLlmTools)),
      });
      if (!quest) throw new NotFoundError('Failed to create quest');
      const questId = quest.id;
      logger.updateMetadata({ questId, sessionId });

      asyncPromises.push(userRepository.update({ id: user.id, lastNotebookId: sessionId }));
      track(
        Promise.all(asyncPromises).then(
          () => undefined,
          error => logger.warn('[TURNS] Session side effects failed', { error: serializeError(error) })
        )
      );

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      write(SSE_KEEPALIVE);
      write(buildMetaEvent(requestId));
      heartbeat = setInterval(() => write(SSE_KEEPALIVE), HEARTBEAT_INTERVAL_MS);
      write({ type: 'turn', quest_id: questId, session_id: sessionId });

      const differ = new TurnReplyDiffer(questId);
      // Frames carry no errorCode, so the closing events come from the stored quest, read once the
      // processing has returned. A terminal frame is not used: the cancellation watcher sends its
      // 'stopped' frame from a reload whose replies can predate the final saved text. A failed read
      // leaves the turn unsettled, which the end of the handler reports.
      const settleFromStore = async () => {
        try {
          const stored = await storedSnapshot(questId);
          if (stored) differ.settle(stored).forEach(event => write(event));
        } catch (error) {
          logger.warn('[TURNS] Settle read failed', { error: serializeError(error) });
        }
      };

      if (questStartParams) {
        const params = questStartParams;
        const tee = createTurnFrameTee({
          questId,
          forward: new ClientMessageSender(getStaticOptions().db, logger),
          onFrame: snapshot => differ.observe(snapshot).forEach(event => write(event)),
        });
        quotaHandedOff = true;
        const releaseQuota = quota;
        const task = processQuest(params, logger, { clientMessageSender: tee })
          .catch(error => handleQuestProcessingFailure(error, { questId, logger, track, surface: 'session-turns' }))
          .finally(() => releaseQuota.release());
        track(task);
        await task;
      }
      // When invoke settled the quest itself (an access or credit refusal), nothing was dispatched
      // and the stored quest already holds the outcome.
      await settleFromStore();

      if (!differ.isSettled) {
        logger.error('[TURNS] Quest still unfinished after processing returned');
        write(formatSSEError(new Error('The turn did not report a final status.'), requestId, 'provider_error'));
      }
      write(SSE_DONE_SIGNAL);
      res.end();
    } catch (error) {
      const jsonError = toJsonError(error, requestId);
      logger[jsonError.status < 500 ? 'warn' : 'error']('[TURNS] Handler error', { error: serializeError(error) });
      try {
        if (res.headersSent) {
          write(formatSSEError(error instanceof HTTPError ? error : new Error('Internal error'), requestId));
          write(SSE_DONE_SIGNAL);
          res.end();
        } else {
          res.status(jsonError.status).set(jsonError.headers).json(jsonError.body);
        }
      } catch (responseError) {
        logger.error('[TURNS] Failed to write error response', { error: serializeError(responseError) });
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (!quotaHandedOff) await quota.release();
    }
  });
  app.use(TURNS_ENDPOINT, bodyParserErrorHandler({ endpoint: TURNS_ENDPOINT, logTag: '[TURNS]' }));

  app.all(TURNS_ENDPOINT, (req: Request, res: Response, next: NextFunction) => {
    const result = checkTurnsMethod(req.method);
    if (result.allowed) return next();
    const requestId = requestIdFrom(flattenHeaders(req.headers));
    res
      .status(405)
      .set({ Allow: result.allowHeader, [REQUEST_ID_HEADER]: requestId })
      .json({ error: result.message, request_id: requestId });
  });
}
