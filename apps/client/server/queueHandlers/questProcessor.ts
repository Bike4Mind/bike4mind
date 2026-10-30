import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import {
  connectDB,
  questRepository,
  Session,
  sessionRepository,
  User,
  defineAbilitiesFor,
  mongoose,
  adminSettingsRepository,
  userRepository,
  questMasterPlanRepository,
  Connection,
  fabFileRepository,
  fabFileChunkRepository,
  projectRepository,
  organizationRepository,
  mcpServerRepository,
  creditTransactionRepository,
  agentRepository,
  skillRepository,
  promptRepository,
  apiKeyRepository,
  rapidReplyMappingRepository,
  rapidReplyResultRepository,
  cacheRepository,
  mementoRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fallbackLakeSettingsRepository,
  latticeModelRepository,
  lakeAccessEventRepository,
  Quest,
  scopedSettingsRepository,
  usageEventRepository,
  newAccountSpendCapAdapters,
} from '@bike4mind/database';
import { lakeWriteToolDb } from '@bike4mind/server-utils/dataLakes/lakeWriteToolDb';
import { NotFoundError } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { z } from 'zod';
import { QuestStartBodySchema, ChatCompletionProcess } from '@bike4mind/services/llm';
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { withLatticeTools } from '@bike4mind/server-utils/queueHandlers/latticeChatTools';
import { adminAssistantToolDefinitions } from '@server/adminAssistant';
import { premiumLlmTools } from '@bike4mind/server-utils/premium-generated/premiumLlmTools.generated';
import { ownerWithheldUsers, withholdAdminRole } from '@server/auth/apiKeyAdminScope';
import { premiumWorkspaceDeniedTools } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceDeniedTools.generated';
import { premiumWorkspaceSessionSettings } from '@bike4mind/server-utils/premium-generated/premiumWorkspaceSessionSettings.generated';
import { Resource } from 'sst';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { logEvent } from '@server/utils/analyticsLog';
import { recordFirstChatValue } from '@server/analytics/funnel';
import { summarizeSession, contextSummarizeSession } from '@server/managers/sessionManager';
import { getUserEntitlements } from '@server/entitlements';
import { resolveThinkingVisibility } from '@server/utils/thinkingVisibility';
import { operationalBillingAdapters } from '@server/billing/operationalBilling';
import { accessibleBy } from '@casl/mongoose';
import { IUserDocument, Permission } from '@bike4mind/common';
import { LLMEvents, SessionEvents } from '@server/utils/eventBus';
import { getSharedTokenizer, publishTelemetryAlertCallback } from '../utils/chatCompletionDefaults';
import { recallMementosV2 } from '@server/memory/recallMementosV2';
import { recallLakeMemoryForSession } from '@server/memory/lakeMemoryRecall';
import { loadSystemPromptById } from '@bike4mind/server-utils/utils/sessionSystemPromptResolver';
import { slackToolDefinitions, createPendingActionToolDefs } from '@bike4mind/slack';
import { cancelPendingActionOnQuest } from '@server/utils/pendingActionExecutor';
import { buildVideoToolConfig } from '@bike4mind/server-utils/videoGenerations/buildVideoToolConfig';
import { buildMusicToolConfig } from '@bike4mind/server-utils/musicGenerations/buildMusicToolConfig';
import {
  getCreateMusicJobDeps,
  getCreateVideoJobDeps,
  getMusicJobDeps,
  getVideoJobDeps,
} from '@server/generationJobs/wiring';
import { getMcpClientAdapter } from '@server/utils/getMcpClientAdapter';
import { createCompletionMeter } from '@server/billing/meterPlatformCompletion';
import { checkFreeTierDailySpendCap, isFreeTierDailyCapError } from '@server/billing/freeTierDailyCapGate';
import { imageModerationIncidents } from '@server/moderation/imageModerationIncidents';

// Cache static ChatCompletion options (DB repos, storage clients, config) across invocations;
// dynamic per-request properties (user, sessionId, logger) are added below. Tokenizer is a
// module-level singleton (shared WASM encoder cache across warm invocations).
type ChatCompletionOptions = ConstructorParameters<typeof ChatCompletionProcess>[0];
type StaticChatCompletionOptions = Omit<ChatCompletionOptions, 'logger' | 'tokenizer' | 'sessionId' | 'user'>;

let cachedStaticOptions: StaticChatCompletionOptions | null = null;
let cachedDbConnection: typeof mongoose.connection | null = null;

const staticOptionsLogger = new Logger({ metadata: { handler: 'questProcessor' } });

export const getStaticOptions = () => {
  if (cachedStaticOptions) {
    staticOptionsLogger.debug('Reusing cached static ChatCompletion options');
    return cachedStaticOptions;
  }

  staticOptionsLogger.debug('Initializing static ChatCompletion options (first invocation)');
  cachedStaticOptions = {
    db: {
      sessions: sessionRepository,
      quests: questRepository,
      questMasterPlans: questMasterPlanRepository,
      users: userRepository,
      apiKeys: apiKeyRepository,
      adminSettings: adminSettingsRepository,
      connections: Connection,
      fabfiles: fabFileRepository,
      fabfilechunks: fabFileChunkRepository,
      dataLakes: dataLakeRepository,
      dataLakeAccessGrants: dataLakeAccessGrantRepository,
      fallbackLakeSettings: fallbackLakeSettingsRepository,
      mementos: mementoRepository,
      projects: projectRepository,
      organizations: organizationRepository,
      mcpServers: mcpServerRepository,
      newAccountSpendCap: newAccountSpendCapAdapters,
      creditTransactions: creditTransactionRepository,
      usageEvents: usageEventRepository,
      operationalBilling: operationalBillingAdapters,
      agents: agentRepository,
      skills: skillRepository,
      prompts: promptRepository,
      rapidReply: {
        mappings: rapidReplyMappingRepository,
        settings: {
          getSettings: async () => {
            return await adminSettingsRepository.getSettingsValue('RapidReplySettings');
          },
        },
        results: {
          createResult: async data => {
            await rapidReplyResultRepository.createResult(data);
          },
          updateResult: async (id: string, data: any) => {
            return await rapidReplyResultRepository.updateResult(id, data);
          },
          updateResultByQuestId: async (questId: string, data: any) => {
            return await rapidReplyResultRepository.updateResultByQuestId(questId, data);
          },
          findByQuestId: async (questId: string) => {
            return await rapidReplyResultRepository.findByQuestId(questId);
          },
          findLatestBlankRapidReplyBySessionId: async (sessionId: string) => {
            return await rapidReplyResultRepository.findLatestBlankRapidReplyBySessionId(sessionId);
          },
        },
      },
      caches: cacheRepository,
      // Lattice tools persist models to Mongo and reload them by ObjectId on
      // subsequent calls (add_entity / set_value / query). Without this adapter
      // they fall back to an in-memory id that fails the ObjectId guard, silently
      // breaking the create-populate-query chain. Required for the `enableLattice`
      // tools registered below to actually work.
      latticeModels: latticeModelRepository,
      // Audit trail for images blocked by the image_generation/edit_image tools'
      // moderation gate. The gate itself is unconditional (constructed inline
      // in the tool) - this only wires the incident record, not the block.
      imageModerationIncidents,
      lakeAccessEvents: lakeAccessEventRepository,
      scopedSettings: scopedSettingsRepository,
      ...lakeWriteToolDb,
    },
    storage: getFilesStorage(),
    imageGenerateStorage: getGeneratedImageStorage(),
    imageProcessorLambdaName: Resource.ImageProcessor.name,
    wsHttpsUrl: Resource.websocket.managementEndpoint,
    slackWebhookUrl: Config.SLACK_WEBHOOK_URL,
    abilityGetter: defineAbilitiesFor,
    workspaceDeniedTools: premiumWorkspaceDeniedTools,
    workspaceSessionSettings: premiumWorkspaceSessionSettings,
    getScopeFilter: (user: IUserDocument, permission: Permission, modelName: string) =>
      accessibleBy(defineAbilitiesFor(user), permission).ofType(mongoose.models[modelName]),
    // Resolve the caller's entitlement keys so retrieval can reach entitlement-gated lakes
    // (e.g. a tag-less, entitlement-only subscriber). Pure function ref - safe to cache; the
    // per-request, per-user resolution happens inside ChatCompletionProcess.resolveEntitlementKeys.
    getEntitlements: getUserEntitlements,
    getThinkingVisibility: resolveThinkingVisibility,
    autoNameSession: autoNameSessionAdapter,
    invokeCreateMemento: async (
      questId: string,
      sessionId: string,
      userId: string,
      prompt: string,
      model: string,
      flags: { enableMementos: boolean; enableMementosV2: boolean }
    ) => {
      await LLMEvents.CompletionCompleted.publish({
        questId,
        sessionId,
        userId,
        prompt,
        model,
        // Forward the resolved write gates so the memento subscriber does not re-default V1 on.
        enableMementos: flags.enableMementos,
        enableMementosV2: flags.enableMementosV2,
      });
    },
    recallMementosV2,
    recallLakeMemory: recallLakeMemoryForSession,
    // Without this the worker resolves session.systemPromptId to undefined, so a triage session
    // gets no authored prompt while the route has already suppressed the brand identity.
    loadSystemPromptById,
    summarizeSession: summarizeSession,
    contextSummarizeSession: contextSummarizeSession,
    getMcpClient: getMcpClientAdapter,
    logEvent: logEvent,
    cacheRepository: cacheRepository,
    publishTelemetryAlert: publishTelemetryAlertCallback,
    telemetryHmacSecret: Resource.SECRET_ENCRYPTION_KEY.value,
  };

  return cachedStaticOptions;
};

const autoNameSessionAdapter = async (sessionId: string, logger: Logger): Promise<string | null> => {
  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Session ${sessionId} not found for auto-naming`);
    return null;
  }

  try {
    logger.info('Publishing auto-naming event', { sessionId, userId: session.userId });
    await SessionEvents.AutoName.publish({
      sessionId,
      userId: session.userId,
    });
    logger.info('Auto-naming event published successfully', { sessionId });
    return null; // Return null as naming happens asynchronously now
  } catch (error) {
    logger.error('Failed to publish auto-naming event', { sessionId, error });
    throw error;
  }
};

/**
 * API-key turns must not start billed video jobs: that would bypass the video-generations contract's
 * scope check and rate limit, so only session-authenticated turns are offered the tool.
 */
export const getVideoToolConfigResolver = (apiKeyId: string | undefined, userId: string) =>
  apiKeyId
    ? undefined
    : () => buildVideoToolConfig(userId, { availability: getVideoJobDeps(), createDeps: getCreateVideoJobDeps() });

/** Same rule as video: the music-generations contract's scope check and rate limit must not be bypassed. */
export const getMusicToolConfigResolver = (apiKeyId: string | undefined, userId: string) =>
  apiKeyId
    ? undefined
    : () => buildMusicToolConfig(userId, { availability: getMusicJobDeps(), createDeps: getCreateMusicJobDeps() });

/**
 * Quest Processor - shared processing core.
 *
 * Runs a single chat-completion quest end-to-end (load user/session, assemble
 * context, call the model, stream over WebSocket, persist). Designed for warm
 * reuse: the static options and DB connection are module-level singletons, so a
 * long-running container pays the setup cost once and every quest after is warm.
 *
 * Invoked by the always-on ChatCompletion HTTP server (see
 * `apps/client/server/chatCompletion/server.ts`). The caller has already validated
 * `params` against `QuestStartBodySchema` (= `LLMEvents.CompletionStart.schema`).
 */
export async function processQuest(params: z.infer<typeof QuestStartBodySchema>, logger: Logger): Promise<void> {
  const handlerStartTime = Date.now();
  logger.debug('Quest processor start');

  // Reuse DB connection if available (the service keeps the container warm)
  if (!cachedDbConnection || mongoose.connection.readyState !== 1) {
    const dbStartTime = Date.now();
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
    cachedDbConnection = mongoose.connection;
    logger.debug('MongoDB connected (new)', { durationMs: Date.now() - dbStartTime });
  } else {
    logger.debug('Reusing existing DB connection', { readyState: mongoose.connection.readyState });
  }

  // Load user and session in parallel for better performance
  const queryStartTime = Date.now();
  const [storedUser, session] = await Promise.all([
    User.findById(params.userId),
    sessionRepository.findById(params.sessionId),
  ]);
  logger.debug('User and session queries completed', { durationMs: Date.now() - queryStartTime });

  if (!storedUser) throw new NotFoundError('User not found');

  logger.updateMetadata({
    userId: params.userId,
    sessionId: params.sessionId,
    questId: params.questId,
  });

  // Validate session exists before processing
  if (!session) {
    // Update quest to stopped status
    await questRepository.update({
      id: params.questId,
      status: 'stopped',
      replies: ['Session not found. Please create a new session or refresh the page.'],
    });

    throw new NotFoundError('Session not found');
  }

  // Every quest-creating surface (web app, public chat API, Slack, voice proxy) lands here, so this
  // is the cap's backstop. A capped turn is the user's limit, not a processing failure: settle the
  // quest with the reason instead of throwing into the route's generic-failure reply and metric.
  try {
    await checkFreeTierDailySpendCap({
      user: storedUser,
      billingOrganizationId: params.organizationId,
      usageEventRepository,
      logger,
    });
  } catch (error) {
    if (!isFreeTierDailyCapError(error)) throw error;
    logger.info('Quest refused by the free-tier daily spend cap', { questId: params.questId });
    await questRepository.settleIfUnfinished(params.questId, {
      status: 'stopped',
      type: 'error',
      reply: error.message,
      replies: [error.message],
    });
    return;
  }

  // Withholding mutates the document, so do it after the billing exemption check.
  const user = params.adminRoleWithheld ? withholdAdminRole(storedUser) : storedUser;

  // Prepare the request body with server-side searchers augmentation
  // Note: searchers are server-side only and not part of the API schema
  type ServerSideQuestBody = z.infer<typeof QuestStartBodySchema> & {
    params: z.infer<typeof QuestStartBodySchema>['params'] & {
      deepResearchConfig?: {
        maxDepth?: number;
        duration?: number;
        searchers?: unknown[];
      };
    };
  };
  const requestBody: ServerSideQuestBody = {
    ...params,
    params: {
      ...params.params,
    },
  };

  // Use cached static options + add dynamic properties per request
  const optionsStartTime = Date.now();
  const staticOptions = getStaticOptions();
  const chatCompletion = new ChatCompletionProcess({
    ...staticOptions,
    // Override with request-specific dynamic properties
    // A tool that re-reads the owner by id must see the same withheld role as `user`.
    db: params.adminRoleWithheld
      ? { ...staticOptions.db, users: ownerWithheldUsers(params.userId, staticOptions.db.users) }
      : staticOptions.db,
    logger,
    tokenizer: getSharedTokenizer(logger),
    sessionId: params.sessionId,
    user,
    createCompletionMeter: ({ organizationId, featureLabel }) =>
      createCompletionMeter(user, logger, featureLabel, { sessionId: params.sessionId, organizationId }),
  });
  logger.debug('ChatCompletionProcess instantiation', { durationMs: Date.now() - optionsStartTime });

  const timeToProcess = Date.now() - handlerStartTime;
  logger.debug('Calling chatCompletion.process', { durationMs: timeToProcess });
  // Build external tools: base Slack tools + conditional pending action tools,
  // plus Lattice definitions when the feature is enabled. These can't be
  // serialized through EventBridge, so they're supplied to process() directly.
  let externalTools: Record<string, ToolDefinition> | undefined;
  if (requestBody.enableSlackTools) {
    externalTools = { ...slackToolDefinitions };

    // Add the cancel tool only when the tools array includes it
    if (requestBody.tools?.includes('cancel_pending_action')) {
      const pendingTools = createPendingActionToolDefs({
        sessionId: params.sessionId,
        cancelPendingAction: cancelPendingActionOnQuest,
        findQuestWithPendingAction: (sessionId: string) =>
          Quest.findOne({ sessionId, pendingAction: { $exists: true } }).sort({ createdAt: -1 }),
      });
      Object.assign(externalTools, pendingTools);
    }
  }

  // Register Lattice tool definitions as externalTools when the flag is set, so
  // the names appended inside ChatCompletionProcess actually resolve.
  externalTools = withLatticeTools(externalTools, requestBody.enableLattice);

  // Premium overlay tool implementations (PremiumOverlayToolName): their names
  // live in the b4mLLMTools enum but their implementations are not in b4mTools;
  // without this merge an enabled premium tool silently no-ops. Spread first so
  // explicit Slack/pending/Lattice tools win on any collision.
  externalTools = { ...premiumLlmTools, ...externalTools };

  // Admin assistant tools: empty unless the DB-loaded user is an admin. The session-surface gate
  // in ChatCompletionProcess decides whether they are enabled; spread first so they never shadow
  // an existing external tool.
  externalTools = { ...adminAssistantToolDefinitions(user), ...externalTools };

  await chatCompletion.process({
    body: requestBody,
    logger,
    externalTools,
    videoToolConfigResolver: getVideoToolConfigResolver(params.apiKeyId, user.id),
    musicToolConfigResolver: getMusicToolConfigResolver(params.apiKeyId, user.id),
  });

  await recordFirstChatValue({
    user,
    loadQuest: () => questRepository.findById(params.questId),
  });

  return;
}
