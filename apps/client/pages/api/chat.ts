import {
  ChatCompletionFeature,
  ChatCompletionInvoke,
  ChatCompletionProcess,
  featureNames,
} from '@bike4mind/services/llm';
import {
  BadRequestError,
  getSettingsMap,
  getSettingsValue,
  NotFoundError,
  SQSService,
  UnprocessableEntityError,
} from '@bike4mind/utils';
import { sessionService } from '@bike4mind/services';
import { PipelineTimer } from '@bike4mind/llm-adapters';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { adminRoleWithheldFor } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import {
  getDefaultChatCompletionOptions,
  getSharedTokenizer,
  isChatModelUsable,
  resolveDefaultChatModel,
} from '@server/utils/chatCompletionDefaults';
import {
  adminSettingsRepository,
  agentRepository,
  fabFileRepository,
  projectRepository,
  questRepository,
  sessionRepository,
  usageEventRepository,
  User,
  Session,
} from '@bike4mind/database';
import {
  B4MLLMTools,
  BadGatewayError,
  chatContract,
  filterKnownTools,
  GatewayTimeoutError,
  OUTPUT_BUDGET_EXHAUSTED_ERROR_CODE,
  REQUEST_TIMEOUT_ERROR_CODE,
  questReplyText,
  toToolPayloads,
  type ChatToolMode,
  type RequestBodyOf,
  type SimplifiedChatRequest,
} from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { resolveSessionOrigin } from '@server/managers/sessionOrigin';
import type { Request, Response } from 'express';
import { dispatchQuest } from '@server/utils/dispatchQuest';
import { premiumLlmTools } from '@server/premium-generated/premiumLlmTools.generated';
import { recommendTools, mergeTools } from '@client/app/utils/toolRecommender';
import { resolveActiveOrg } from '@bike4mind/server-utils/utils/resolveActiveOrg';
import { dataLakeToolsDeniedFor } from '@server/dataLakes/dataLakeScopes';
import { requestTurnAuth } from '@server/auth/turnAuth';
import { createCompletionMeter } from '@server/billing/meterPlatformCompletion';
import { admitApiKeyCompletion, NO_COMPLETION_QUOTA } from '@server/utils/untrustedCompletionQuota';
import { checkFreeTierDailySpendCap } from '@server/billing/freeTierDailyCapGate';
import { runWithDeadline, WAIT_TURN_BUDGET_MS, WAIT_TURN_WIND_DOWN_MS } from '@server/utils/waitTurnDeadline';
import {
  TIMED_OUT_RUN,
  applyRecoveryInMemory,
  terminalRecoveryFor,
} from '@bike4mind/server-utils/chatCompletion/questTimeoutRecovery';

// How many distinct unrecognized tool ids are named in the warn log and echoed on the response.
// Both are bounded by the same number so the response is no less bounded than the log; the cap is
// part of the documented contract (see the `tools` description in schemas/chat.ts).
const UNRECOGNIZED_TOOL_REPORT_LIMIT = 10;

type ChatRequest = Request & { validated: RequestBodyOf<typeof chatContract> };

// Auth mode, required scopes, and request validation all come from chatContract
// (the single source of truth also driving the OpenAPI spec). `req.validated` is
// the parsed, typed body. Rate limit is passed as an option so the adapter orders
// it before validation (a malformed body still counts against the limiter).
const handler = nextRouteForContract(chatContract, {
  // Per-user request rate limit, tunable per subscription tier. Keyed on userId
  // (IP-independent); admins/developers and the dev server bypass.
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user, req),
    windowMs: 60 * 1000,
  }),
}).post(async (req, res) => {
  // Admitted before the notebook is resolved, so a refused turn creates nothing. Only a blocking
  // turn holds a concurrency slot: a queued one finishes in the ChatCompletion service.
  const quota = isApiKeyAuth(req)
    ? await admitApiKeyCompletion({
        owner: req.user,
        ownerUntrusted: req.apiKeyInfo?.ownerUntrusted,
        billingOwnerType: req.apiKeyInfo?.billingOwnerType,
        holdSlot: Boolean(req.validated.wait),
        req,
      })
    : NO_COMPLETION_QUOTA;
  let completionStarted = false;
  const runCompletion = async (complete: () => Promise<unknown>): Promise<unknown> => {
    completionStarted = true;
    try {
      return await complete();
    } finally {
      await quota.release();
    }
  };
  try {
    return await handleChat(req, res, runCompletion);
  } finally {
    // A timed-out provider can outlive the response; its completion still owns the slot.
    if (!completionStarted) await quota.release();
  }
});

async function handleChat(
  req: ChatRequest,
  res: Response,
  runCompletion: (complete: () => Promise<unknown>) => Promise<unknown>
) {
  const requestStartedAt = Date.now();
  const apiTimer = new PipelineTimer();
  apiTimer.phase('settings');

  // Admin settings (uses the cached AdminSettingsCache); reused below for the embedding model.
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });

  const simplifiedRequest = req.validated;

  // An explicit request model wins. Otherwise fall back to the admin default, which on a
  // local-only self-host box may itself need a fallback (see resolveDefaultChatModel), so
  // only probe when no explicit model was sent.
  let model = simplifiedRequest.model;
  if (!model) {
    const resolved = await resolveDefaultChatModel({
      configuredModel: getSettingsValue('DefaultAPIModel', settings),
      userId: req.user.id,
      logger: req.logger,
    });
    model = resolved.model;
    // Self-host, no-explicit-model guard: apiKeys/models are populated only on self-host.
    // If even the resolved default is unusable (no provider key and no local model), fail
    // fast with actionable guidance instead of a cryptic backend error deep in the pipeline.
    if (resolved.apiKeys && resolved.models) {
      const info = resolved.models.find(m => m.id === model);
      if (!isChatModelUsable(resolved.apiKeys, info, req.logger)) {
        throw new BadRequestError(
          'No usable default chat model is configured. Set a provider key (e.g. ANTHROPIC_API_KEY) in ' +
            '.env.selfhost, enable local models via OLLAMA_BASE_URL, or pass an explicit "model" from GET /api/models.'
        );
      }
    }
  }

  // Pre-compute tool recommendations once (used by both transform and response metadata)
  const recommendations = simplifiedRequest.toolMode === 'smart' ? recommendTools(simplifiedRequest.message) : [];

  // Split the caller's explicit tool ids into what this deployment recognizes and what it does
  // not. Computed here rather than inside the transform for the same reason `recommendations`
  // is - both the invoked body and the response metadata need it. No public endpoint enumerates
  // the valid ids, so a dropped id has to be reported back or a typo is indistinguishable from
  // a tool that does not exist here.
  //
  // Every quantity below is a Set, because `tools` carries no length bound of its own:
  //  - Set membership, not Array.includes, for the split - a payload mixing many known with many
  //    unknown ids makes a linear scan quadratic (~1s of blocked event loop at the 1MB body cap,
  //    before any billing or model call).
  //  - The recognized ids are deduped before they leave this layer. Nothing downstream collapses
  //    repeats (`resolveEnabledTools` only appends), and a repeated id would consume a per-tool
  //    slice of the verbatim history budget per copy and reach the provider as a duplicate tool
  //    name. The other branches already deduped: `smart` via `mergeTools`, `fast` via `[]`.
  //  - The unrecognized ids are deduped too: what a caller debugging a typo needs is the SET of
  //    ids that are not tools here, not one entry per occurrence.
  const requestedTools = Array.from(new Set(filterKnownTools(simplifiedRequest.tools)));
  const recognized = new Set<string>(requestedTools);
  const unrecognizedIds = new Set((simplifiedRequest.tools ?? []).filter(id => !recognized.has(id)));
  const unrecognizedTools = Array.from(unrecognizedIds).slice(0, UNRECOGNIZED_TOOL_REPORT_LIMIT);
  if (unrecognizedIds.size > 0) {
    req.logger.warn(
      `POST /api/chat dropped ${unrecognizedIds.size} unrecognized tool id(s): ${unrecognizedTools.join(', ')}`
    );
  }

  // Billing target is an explicit, opt-in choice - never an automatic consequence of the
  // caller's home-org field. When the request names an organizationId we validate the caller
  // actually belongs to it (resolveActiveOrg; throws 403/404 otherwise) and bill + scope
  // team-wide prompts to it; when omitted, the turn is personal (CreditHolderType.User). This
  // is what lets an org member whose org pool is empty still spend their own credits.
  const organizationId = await resolveActiveOrg(req, simplifiedRequest.organizationId);

  // Refuse capped turns before creating a notebook or quest.
  await checkFreeTierDailySpendCap({
    user: req.user,
    req,
    billingOrganizationId: organizationId,
    usageEventRepository,
    logger: req.logger,
  });

  // Resolve the notebook only AFTER the org check: an API-key/newConversation caller gets a
  // freshly created notebook, and a request that resolveActiveOrg rejects (403/404) must not have
  // already minted one. `createdNotebook` marks a session this request opened, so a later reject
  // from invoke (an unknown/disabled model) can remove it - see the invoke try/catch below.
  apiTimer.phase('session');
  const { sessionId, createdNotebook } = await resolveChatSessionId(req, simplifiedRequest);

  // Transform to internal format. The resolved organizationId (already a validated hex string,
  // or undefined for personal) also scopes team-wide system prompts downstream.
  const internalRequest = transformToInternalFormat(
    { ...simplifiedRequest, model, sessionId },
    req.user.id,
    organizationId,
    recommendations,
    requestedTools,
    dataLakeToolsDeniedFor(req)
  );

  // Read off internalRequest.tools rather than recomputing, so what is reported cannot drift
  // from what was actually sent to the service layer.
  const toolMeta = buildToolMeta({
    toolMode: simplifiedRequest.toolMode,
    effectiveTools: internalRequest.tools,
    autoSelectedTools: recommendations.map(r => r.tool),
    unrecognizedTools,
  });

  // Shared options for ChatCompletionInvoke and ChatCompletionProcess
  const chatCompletionOptions = {
    ...getDefaultChatCompletionOptions(),
    queue: new SQSService(), // Create per-request to ensure fresh credentials
    tokenizer: getSharedTokenizer(req.logger),
    user: req.user,
    sessionId: sessionId,
    gpcSignalDetected: req.headers['sec-gpc'] === '1',
    features: new Map<featureNames, ChatCompletionFeature>(),
    logger: req.logger,
    createCompletionMeter: ({
      organizationId,
      featureLabel,
    }: {
      organizationId: string | null;
      featureLabel: string;
    }) => createCompletionMeter(req.user!, req.logger, featureLabel, { sessionId, organizationId }),
    invokeLambda: async (params: any) => {
      if (simplifiedRequest.wait) {
        // wait=true: the quest is processed inline below (ChatCompletionProcess). Do NOT
        // dispatch to the ChatCompletion - that would double-process the quest.
        return;
      }
      // wait=false: hand off to the always-on ChatCompletion (HTTP, 202 ACK).
      await dispatchQuest(params, req.logger);
    },
  };

  // Create the quest (this is immediate)
  apiTimer.phase('invoke');
  const invokeService = new ChatCompletionInvoke(chatCompletionOptions);
  const turnAuth = requestTurnAuth(req);
  let quest: Awaited<ReturnType<ChatCompletionInvoke['invoke']>>;
  try {
    quest = await invokeService.invoke({
      body: internalRequest,
      userId: req.user.id,
      // The key (when one authenticated the turn) also attributes a lake write a tool drives.
      ...turnAuth,
      adminRoleWithheld: adminRoleWithheldFor(req.apiKeyInfo),
    });
  } catch (error) {
    // invoke validates a caller-supplied model (unknown, disabled, no longer accessible) before it
    // creates the quest, so a rejected turn can land here with the fresh notebook already open.
    // Nothing references that notebook yet - remove it rather than leave an empty orphan that
    // disguises itself as a real chat in the list. Best-effort: cleanup must not mask the original
    // error, and invoke throws before quest creation on every path that reaches the caller.
    if (createdNotebook) {
      try {
        await sessionRepository.delete(sessionId);
      } catch (cleanupError) {
        req.logger.warn(
          `Failed to remove notebook ${sessionId} after a rejected turn: ${(cleanupError as Error)?.message}`
        );
      }
    }
    throw error;
  }

  if (!quest) throw new NotFoundError('Failed to create quest');

  if (simplifiedRequest.wait) {
    // Reuse the cached settings map from above - avoids a second uncached DB call.
    const currentEmbeddingModel = getSettingsValue('defaultEmbeddingModel', settings);

    apiTimer.phase('process');
    const processService = new ChatCompletionProcess(chatCompletionOptions);
    const turn = await runWithDeadline(
      abortSignal =>
        runCompletion(() =>
          processService.process({
            body: {
              ...internalRequest,
              questId: quest.id,
              userId: req.user.id,
              // Mirrors invoke() above: process() reads the tool context's auth from this body only.
              ...turnAuth,
              embeddingModel: currentEmbeddingModel,
              queryComplexity: 'simple',
              // Optional schema fields - declared for QuestStartBodySchema type conformance
              dashboardParams: undefined,
              questMaster: undefined,
              researchMode: undefined,
              imageConfig: undefined,
            },
            logger: req.logger,
            // Pass quest from invoke to skip redundant DB read
            prefetchedQuest: quest,
            // Pass session from invoke to skip redundant DB read
            prefetchedSession: invokeService.prefetchedSession,
            // Pass organization from invoke to skip redundant DB read
            prefetchedOrganization: invokeService.prefetchedOrganization,
            // Premium overlay tool implementations: a session whose effective enabledTools
            // (its own, or its workspace's resolved at read time) include premium names needs
            // the merge or those tools silently no-op on this synchronous path.
            externalTools: premiumLlmTools,
            abortSignal,
          })
        ),
      { budgetMs: WAIT_TURN_BUDGET_MS - (Date.now() - requestStartedAt), windDownMs: WAIT_TURN_WIND_DOWN_MS }
    );

    // successStatus() yields 'stopped' once the turn is aborted, so an in-memory 'done' means the
    // full answer was produced before the abort landed (the fenced final save may have dropped it).
    const finishedBeforeAbort =
      turn.outcome === 'aborted' && turn.error === undefined && quest.status === 'done' && quest.type !== 'error';
    if (finishedBeforeAbort) {
      const settled = await questRepository.settleIfUnfinished(quest.id, {
        status: quest.status,
        reply: quest.reply,
        replies: quest.replies,
        fallbackInfo: quest.fallbackInfo,
      });
      req.logger.warn(`POST /api/chat wait=true turn for quest ${quest.id} finished before the deadline abort landed`, {
        settled,
      });
    }

    if (turn.outcome !== 'completed' && !finishedBeforeAbort) {
      // After the abort, process() no longer writes the quest (its saves are fenced), so the
      // terminal state is settled here from what streamed. An aborted turn already refunded or
      // reconciled its own reservation; a stuck one never reached that code, so it is refunded here.
      if (turn.outcome === 'stuck') await processService.releaseReservedCredits(quest.id, req.logger);
      // Judge emptiness from the persisted row, not the in-memory quest: once aborted, saves are
      // fenced, so content a tool added to memory after the last save is never written - judging from
      // memory would skip the timeout error and leave a `done` row with nothing to render. Falls back
      // to the in-memory quest when the row cannot be read.
      //
      // The text is the exception: the recovery patch writes `reply`/`replies` from whatever it is
      // given, and the row is only a heartbeat snapshot up to 10s stale, so taking the text from it
      // would drop the tail that streamed since (or replace a short answer with the timeout error).
      // Keep the in-memory text and take only the fields the patch cannot write from the row.
      const persistedQuest = await questRepository.findById(quest.id).catch(() => null);
      const recovery = terminalRecoveryFor(
        { ...(persistedQuest ?? quest), reply: quest.reply, replies: quest.replies },
        TIMED_OUT_RUN
      );
      const settled = await questRepository.settleIfUnfinished(quest.id, recovery);
      req.logger.warn(`POST /api/chat wait=true turn for quest ${quest.id} ran past its deadline`, {
        outcome: turn.outcome,
        settled,
        ...(turn.outcome === 'aborted' && turn.error !== undefined && { error: turn.error }),
      });
      if (settled) {
        // process()'s own final push on a caller abort sent the still-running quest.
        applyRecoveryInMemory(quest, recovery);
        await processService
          .sendStatusUpdate(quest, null, { skipPayloadOptimization: true })
          .catch(err => req.logger.warn(`Failed to push settled timeout state for quest ${quest.id}`, { err }));
      }
      const timeoutError = new GatewayTimeoutError(
        'This turn ran past the wait=true deadline and was ended. Send long turns without wait and poll the quest.',
        { errorCode: REQUEST_TIMEOUT_ERROR_CODE, quest_id: quest.id, sessionId }
      );
      // A deadline we enforce on purpose, not a server fault: errorHandler logs it at warn.
      timeoutError.expected = true;
      throw timeoutError;
    }

    // A reasoning model spent its whole output budget: process() settled the quest as an error
    // without rethrowing. Who chose the budget decides the status - the caller (422) or us (502).
    if (processService.terminalError) {
      const details = { quest_id: quest.id, sessionId };
      const budgetError =
        internalRequest.params.max_tokens !== undefined
          ? new UnprocessableEntityError(
              'The model used its whole max_tokens budget reasoning before it could answer. Raise max_tokens, or omit it to use the model default.',
              { errorCode: OUTPUT_BUDGET_EXHAUSTED_ERROR_CODE, ...details }
            )
          : new BadGatewayError('The model used its whole output budget reasoning before it could answer.', details);
      // An expected, classified failure rather than a server fault: errorHandler logs it at warn.
      budgetError.expected = true;
      throw budgetError;
    }

    // Use the in-memory quest directly - process() mutates it in place with
    // reply, replies, status, promptMeta. No need to re-fetch from DB.
    const completedQuest = quest;

    apiTimer.end();

    // Read pipeline phases directly from the process instance (avoids Mongoose Map serialization issues)
    const pipelinePhases = processService.pipelinePhases;
    const performance = {
      total_ms: apiTimer.totalMs(),
      phases: apiTimer.toRecord(),
      ...(pipelinePhases && { pipeline_phases: pipelinePhases }),
    };

    req.logger.info(`📊 API phases:\n${apiTimer.summary()}`);

    return res.json({
      id: completedQuest.id,
      status: completedQuest.status,
      sessionId,
      message_received: true,
      timestamp: new Date().toISOString(),
      model: completedQuest.promptMeta?.model?.name ?? internalRequest.params.model,
      response: questReplyText(completedQuest),
      responses: completedQuest.replies,
      // Terminal-failure classifier (see chatContract's 200 description). `type` is present
      // unconditionally, matching the polled quest (GET /api/v1/quests/{id}); `errorCode` stays
      // conditional since only the billing failures set it.
      type: completedQuest.type,
      ...(completedQuest.type === 'error' && { errorCode: completedQuest.errorCode }),
      // Additive twin of `response`: the machine-readable state the turn's tools produced, which
      // otherwise survives only on the quest (the model sees a terse displayMessage instead). The
      // prose above is unchanged - a caller reads one, the other, or both.
      toolPayloads: toToolPayloads(completedQuest.uiSideEffects),
      createdAt: completedQuest.createdAt,
      ...(simplifiedRequest.includePromptDetails && completedQuest.promptMeta?.context?.systemPromptDetails
        ? { promptDetails: completedQuest.promptMeta.context.systemPromptDetails }
        : {}),
      // Read off the process instance, not the quest: the disclosed text is deliberately never
      // persisted, so this response is the only place it exists.
      ...(processService.systemPromptText && { promptText: processService.systemPromptText }),
      ...(toolMeta && { tools: toolMeta }),
      performance,
      tracking_info: {
        quest_id: completedQuest.id,
        check_status_url: `/api/quests/${completedQuest.id}`,
      },
    });
  }

  // Default behavior: Return immediate "message received" confirmation with quest ID
  apiTimer.end();
  req.logger.info(`📊 API phases (async):\n${apiTimer.summary()}`);

  return res.json({
    id: quest.id,
    status: 'queued',
    sessionId,
    message_received: true,
    timestamp: new Date().toISOString(),
    // invoke swaps a retired id for its successor; report the model the turn runs on.
    model: quest.promptMeta?.model?.name ?? internalRequest.params.model,
    message: 'Message queued for processing. Use the quest ID to check status.',
    ...(toolMeta && { tools: toolMeta }),
    tracking_info: {
      quest_id: quest.id,
      check_status_url: `/api/quests/${quest.id}`,
      poll_url: `/api/quests/${quest.id}`,
    },
  });
}

/**
 * The tool decision this layer made, echoed back as the response's `tools` field so a caller can
 * see what was offered - and what was thrown away. `toolMode` is absent when the caller named
 * tools without sending a mode.
 *
 * `unrecognizedTools` is deliberately NOT conditioned on `toolMode`: it states a fact about this
 * deployment's tool registry ("these ids are not tools here"), which is true whatever the mode did
 * with the array. `effectiveTools` is the separate, turn-level answer to "what was actually
 * offered" - under 'fast' that is `[]`, which is what tells a caller their array was discarded. The
 * two are orthogonal, so the mode-dropped set stays derivable (requested minus effective minus
 * unrecognized) without conflating a typo with a deliberate drop. Naming it for the registry rather
 * than the outcome is what keeps it honest under 'fast', where a recognized id is dropped too and
 * an outcome-shaped name (`ignoredTools`, `droppedTools`) would under-report.
 *
 * Undefined only when the layer made no decision AND had nothing to report: the enableTools path,
 * where the service layer resolves the set.
 */
function buildToolMeta({
  toolMode,
  effectiveTools,
  autoSelectedTools,
  unrecognizedTools,
}: {
  toolMode: ChatToolMode | undefined;
  effectiveTools: B4MLLMTools[] | undefined;
  autoSelectedTools: B4MLLMTools[];
  unrecognizedTools: string[];
}) {
  const unrecognized = unrecognizedTools.length > 0 ? { unrecognizedTools } : {};

  if (toolMode === 'smart') {
    return { toolMode, autoSelectedTools, effectiveTools: effectiveTools ?? [], ...unrecognized };
  }
  if (toolMode === 'fast') {
    return { toolMode, effectiveTools: [], ...unrecognized };
  }
  if (effectiveTools?.length || unrecognizedTools.length > 0) {
    return { effectiveTools: effectiveTools ?? [], ...unrecognized };
  }
  return undefined;
}

/**
 * Resolve the notebook/session this turn is recorded in.
 *
 * An API-key caller with no `sessionId` gets a BRAND-NEW notebook, and so does any caller that
 * sends `newConversation: true`. Neither reads nor writes `User.lastNotebookId`: that field is the
 * human's UI cursor (the notebook the web app reopens), so a script must not be able to post into
 * it or repoint it at its own notebook. A first-party JWT caller with no `sessionId` keeps the old
 * last-notebook fallback. An explicit `sessionId` always wins - its access check lives downstream.
 *
 * `createdNotebook` is true only when this call opened the notebook, so the caller can discard it if
 * a later validation rejects the turn (see the invoke try/catch).
 */
async function resolveChatSessionId(
  req: Request,
  request: SimplifiedChatRequest
): Promise<{ sessionId: string; createdNotebook: boolean }> {
  if (request.sessionId && request.newConversation) {
    throw new UnprocessableEntityError('Pass either sessionId or newConversation, not both');
  }

  if (request.sessionId) {
    return { sessionId: request.sessionId, createdNotebook: false };
  }

  if (request.newConversation || isApiKeyAuth(req)) {
    const session = await sessionService.createSession(
      req.user,
      { name: newNotebookName(req) },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          agents: agentRepository,
        },
        logger: req.logger,
      },
      { origin: resolveSessionOrigin(req) }
    );
    req.logger.info(
      `POST /api/chat created notebook ${session.id} for ${isApiKeyAuth(req) ? 'API key' : 'new conversation'}`
    );
    return { sessionId: session.id, createdNotebook: true };
  }

  const user = await User.findById(req.user.id, { lastNotebookId: 1 });
  if (user?.lastNotebookId) {
    return { sessionId: user.lastNotebookId.toString(), createdNotebook: false };
  }

  const mostRecentSession = await Session.findOne({ userId: req.user.id }).sort({ lastUpdated: -1, createdAt: -1 });
  if (mostRecentSession) {
    // Update user's lastNotebookId for future requests
    await User.findByIdAndUpdate(req.user.id, { lastNotebookId: mostRecentSession.id });
    return { sessionId: mostRecentSession.id, createdNotebook: false };
  }

  throw new NotFoundError('No notebook found. Please create a notebook first using POST /api/v1/sessions');
}

/**
 * Notebook name for a session this endpoint creates on the caller's behalf. The `API` prefix is
 * what makes an API-created notebook identifiable to a human scanning the notebook list; a JWT
 * caller's `newConversation` is labelled as an ordinary new chat instead. ASCII only, UTC-stamped.
 */
function newNotebookName(req: Request): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `${isApiKeyAuth(req) ? 'API chat' : 'New chat'} - ${stamp} UTC`;
}

function transformToInternalFormat(
  request: SimplifiedChatRequest & { sessionId: string; model: string },
  userId: string,
  organizationId?: string,
  recommendations: ReturnType<typeof recommendTools> = [],
  // Already filtered to known ids AND deduped by the caller: unknowns are dropped there so the
  // wire schema stays OpenAPI-representable and so they can be reported back on the response,
  // and repeats are collapsed there because nothing downstream of this layer collapses them.
  requestedTools: B4MLLMTools[] = [],
  // Server-derived only: the public request schema has no deniedTools field for a client to set.
  deniedTools: string[] = []
) {
  // Compute effective tools. `tools` is a top-level field with nothing marking it conditional on
  // toolMode, so a named tool is honored on its own rather than silently dropped; 'fast' ignores
  // it. What lands here seeds `resolveEnabledTools`, which is a union plus a denylist - so this
  // list adds to the offered set and never restricts it.
  let effectiveTools: B4MLLMTools[] | undefined;
  if (request.toolMode === 'smart') {
    effectiveTools = mergeTools(recommendations, requestedTools);
  } else if (request.toolMode === 'fast') {
    effectiveTools = [];
  } else if (requestedTools.length > 0) {
    effectiveTools = requestedTools;
  }
  // With no toolMode and no named tools, leave effectiveTools unset - the service
  // layer resolves the set from enableTools.

  // For capability flags: smart mode is still "tools enabled" even with no auto-selected tools
  const isToolsEnabled =
    request.toolMode === 'smart'
      ? true
      : request.toolMode === 'fast'
        ? false
        : !!request.enableTools || requestedTools.length > 0;

  // Determine capability defaults: legacy enableTools=true defaults to true,
  // toolMode='smart' defaults to false (conservative - just tools, no QuestMaster etc.)
  const isLegacyToolsPath = !request.toolMode && request.enableTools;

  return {
    sessionId: request.sessionId,
    message: request.message,
    historyCount: request.historyCount,
    fabFileIds: [], // Empty by default, clients can use the full API for fab files
    messageFileIds: request.fileIds,
    organizationId, // Include for team-wide system prompts
    toolMode: request.toolMode,
    params: {
      model: request.model,
      // Any of max_tokens / maxTokens / maxOutputTokens expresses the caller's budget.
      // Left undefined when none is given so ChatCompletionProcess can pick a
      // model-aware default - it knows whether the resolved model is an adaptive
      // reasoning model, which needs a larger default to keep extended thinking from
      // consuming the whole budget and leaving an empty reply. Sending a number here
      // would read downstream as a deliberate caller choice and defeat that.
      max_tokens: request.max_tokens ?? request.maxTokens ?? request.maxOutputTokens,
      ...(request.temperature !== undefined && { temperature: request.temperature }),
      stream: request.stream,
    },
    promptMeta: {
      session: {
        id: request.sessionId,
        userId: userId,
        organizationId,
      },
    },
    enableArtifacts: false,
    ...(request.promptMode ? { promptMode: request.promptMode } : {}),
    ...(request.skip_auto_offers ? { skipAutoOffers: true } : {}),
    ...(deniedTools.length > 0 ? { deniedTools } : {}),
    includeSystemPrompt: request.includeSystemPrompt,
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    ...(isToolsEnabled
      ? {
          // Legacy enableTools=true callers expect full capabilities by default.
          // toolMode='smart' callers get conservative defaults (just tools).
          enableQuestMaster: request.enableQuestMaster ?? (isLegacyToolsPath ? true : false),
          enableMementos: request.enableMementos ?? (isLegacyToolsPath ? true : false),
          enableAgents: request.enableAgents ?? (isLegacyToolsPath ? true : false),
          ...(effectiveTools && effectiveTools.length > 0 ? { tools: effectiveTools } : {}),
        }
      : { enableQuestMaster: false, enableMementos: false, enableAgents: false, tools: [] }),
  };
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
