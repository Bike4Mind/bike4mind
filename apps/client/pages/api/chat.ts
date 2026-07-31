import { ChatCompletionFeature, ChatCompletionInvoke, ChatCompletionProcess, featureNames } from '@bike4mind/services';
import { BadRequestError, getSettingsMap, getSettingsValue, NotFoundError, SQSService } from '@bike4mind/utils';
import { PipelineTimer } from '@bike4mind/llm-adapters';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import {
  getDefaultChatCompletionOptions,
  getSharedTokenizer,
  isChatModelUsable,
  resolveDefaultChatModel,
} from '@server/utils/chatCompletionDefaults';
import { adminSettingsRepository, User, Session } from '@bike4mind/database';
import { B4MLLMTools, chatContract, filterKnownTools, type SimplifiedChatRequest } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchQuest } from '@server/utils/dispatchQuest';
import { premiumLlmTools } from '@server/premium-generated/premiumLlmTools.generated';
import { recommendTools, mergeTools } from '@client/app/utils/toolRecommender';

// Auth mode, required scopes, and request validation all come from chatContract
// (the single source of truth also driving the OpenAPI spec). `req.validated` is
// the parsed, typed body.
const handler = nextRouteForContract(chatContract)
  .use(
    // Per-user request rate limit, tunable per subscription tier. Keyed
    // on userId (IP-independent); admins/developers and the dev server bypass.
    rateLimit({
      limit: req => resolveUserRateLimitPerMin(req.user),
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
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

    apiTimer.phase('session');
    const sessionId = await getSessionId(simplifiedRequest.sessionId ?? undefined, req.user.id);

    // Pre-compute tool recommendations once (used by both transform and response metadata)
    const recommendations = simplifiedRequest.toolMode === 'smart' ? recommendTools(simplifiedRequest.message) : [];

    // Transform to internal format, including user's organization for team-wide system prompts
    const internalRequest = transformToInternalFormat(
      { ...simplifiedRequest, model, sessionId },
      req.user.id,
      req.user.organizationId ?? undefined,
      recommendations
    );

    // Build tool metadata for response (reuses pre-computed recommendations)
    const toolMeta =
      simplifiedRequest.toolMode === 'smart'
        ? {
            toolMode: 'smart' as const,
            autoSelectedTools: recommendations.map(r => r.tool),
            effectiveTools: internalRequest.tools ?? [],
          }
        : simplifiedRequest.toolMode === 'fast'
          ? { toolMode: 'fast' as const, effectiveTools: [] }
          : undefined;

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
    const quest = await invokeService.invoke({
      body: internalRequest,
      userId: req.user.id,
    });

    if (!quest) throw new NotFoundError('Failed to create quest');

    if (simplifiedRequest.wait) {
      // Reuse the cached settings map from above - avoids a second uncached DB call.
      const currentEmbeddingModel = getSettingsValue('defaultEmbeddingModel', settings);

      apiTimer.phase('process');
      const processService = new ChatCompletionProcess(chatCompletionOptions);
      await processService.process({
        body: {
          ...internalRequest,
          questId: quest.id,
          userId: req.user.id,
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
        // Premium overlay tool implementations: a session whose enabledTools
        // include premium names (set server-side at create) needs the merge or
        // those tools silently no-op on this synchronous path.
        externalTools: premiumLlmTools,
      });

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
        message_received: true,
        timestamp: new Date().toISOString(),
        model: internalRequest.params.model,
        response: completedQuest.reply,
        responses: completedQuest.replies,
        createdAt: completedQuest.createdAt,
        ...(simplifiedRequest.includePromptDetails && completedQuest.promptMeta?.context?.systemPromptDetails
          ? { promptDetails: completedQuest.promptMeta.context.systemPromptDetails }
          : {}),
        ...(toolMeta && { tools: toolMeta }),
        // The tools actually offered to the model server-side: the built tool list after the
        // denylist pass and Ollama trim, so it also includes MCP tools and delegate_to_agent.
        // Unlike toolMeta.effectiveTools (API-layer selection only), this reflects server-side
        // offers like the attached-knowledge auto-offer - the signal an eval needs.
        ...(completedQuest.promptMeta?.offeredTools ? { offeredTools: completedQuest.promptMeta.offeredTools } : {}),
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
      message_received: true,
      timestamp: new Date().toISOString(),
      model: internalRequest.params.model,
      message: 'Message queued for processing. Use the quest ID to check status.',
      ...(toolMeta && { tools: toolMeta }),
      tracking_info: {
        quest_id: quest.id,
        check_status_url: `/api/quests/${quest.id}`,
        poll_url: `/api/quests/${quest.id}`,
      },
    });
  });

/**
 * Get session ID - either from request or user's most recent notebook
 */
async function getSessionId(requestedSessionId: string | undefined, userId: string): Promise<string> {
  if (requestedSessionId) {
    return requestedSessionId;
  }

  const user = await User.findById(userId, { lastNotebookId: 1 });
  if (user?.lastNotebookId) {
    return user.lastNotebookId.toString();
  }

  const mostRecentSession = await Session.findOne({ userId }).sort({ lastUpdated: -1, createdAt: -1 });
  if (mostRecentSession) {
    // Update user's lastNotebookId for future requests
    await User.findByIdAndUpdate(userId, { lastNotebookId: mostRecentSession.id });
    return mostRecentSession.id;
  }

  throw new NotFoundError('No notebook found. Please create a notebook first using POST /api/sessions/create');
}

function transformToInternalFormat(
  request: SimplifiedChatRequest & { sessionId: string; model: string },
  userId: string,
  organizationId?: string,
  recommendations: ReturnType<typeof recommendTools> = []
) {
  // Compute effective tools for smart mode using pre-computed recommendations
  let effectiveTools: B4MLLMTools[] | undefined;
  if (request.toolMode === 'smart') {
    // Drop unknown tool ids here (moved off the wire schema so it stays representable).
    const manualTools = filterKnownTools(request.tools);
    effectiveTools = mergeTools(recommendations, manualTools);
  } else if (request.toolMode === 'fast') {
    effectiveTools = [];
  }
  // When toolMode is unset, don't set effectiveTools - let service layer handle via enableTools

  // For capability flags: smart mode is still "tools enabled" even with no auto-selected tools
  const isToolsEnabled =
    request.toolMode === 'smart' ? true : request.toolMode === 'fast' ? false : !!request.enableTools;

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
