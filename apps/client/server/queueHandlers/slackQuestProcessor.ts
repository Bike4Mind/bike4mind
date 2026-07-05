import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

import {
  connectDB,
  questRepository,
  Quest,
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
  dataLakeRepository,
  latticeModelRepository,
  slackDevWorkspaceRepository,
  usageEventRepository,
  imageModerationIncidentRepository,
} from '@bike4mind/database';
import { NotFoundError, registerLambdaErrorHandlers } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';

// Register global error handlers for enhanced observability of network errors
registerLambdaErrorHandlers();
import { Config } from '@server/utils/config';
import { getUserEntitlements } from '@server/entitlements';
import { z } from 'zod';
import { QuestStartBodySchema, ChatCompletionProcess } from '@bike4mind/services';
import type { ToolDefinition } from '@bike4mind/services/llm/tools';
import { withLatticeTools } from './latticeChatTools';
import { premiumLlmTools } from '@server/premium-generated/premiumLlmTools.generated';
import { Resource } from 'sst';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { logEvent } from '@server/utils/analyticsLog';
import { summarizeSession, contextSummarizeSession } from '@server/managers/sessionManager';
import { accessibleBy } from '@casl/mongoose';
import { IMcpServerDocument, IUserDocument, Permission } from '@bike4mind/common';
import { MCPClient } from '@bike4mind/mcp';
import { buildMcpEnvVariables } from '@server/utils/mcpEnv';
import { invokeMcpHandler } from '@server/utils/invokeMcpHandler';
import { LLMEvents, SessionEvents } from '@server/utils/eventBus';
import { withEventContext } from '@server/events/utils';
import {
  slackToolDefinitions,
  createPendingActionToolDefs,
  SlackClient,
  buildConfirmationButtons,
  formatPreviewFromParams,
  processMarkdownForSlack,
  splitTextIntoBlocks,
} from '@bike4mind/slack';
import { executePendingAction, cancelPendingActionOnQuest } from '@server/utils/pendingActionExecutor';
import { getSharedTokenizer, publishTelemetryAlertCallback } from '../utils/chatCompletionDefaults';
import { decryptToken } from '@server/security/tokenEncryption';

// Cache static ChatCompletion options that don't change between invocations
type ChatCompletionOptions = ConstructorParameters<typeof ChatCompletionProcess>[0];
type StaticChatCompletionOptions = Omit<ChatCompletionOptions, 'logger' | 'tokenizer' | 'sessionId' | 'user'>;

let cachedStaticOptions: StaticChatCompletionOptions | null = null;
let cachedDbConnection: typeof mongoose.connection | null = null;

const getStaticOptions = () => {
  if (cachedStaticOptions) {
    console.log('♻️ [PERFORMANCE] Reusing cached static ChatCompletion options');
    return cachedStaticOptions;
  }

  console.log('🔧 [PERFORMANCE] Initializing static ChatCompletion options (first invocation)');
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
      mementos: mementoRepository,
      projects: projectRepository,
      organizations: organizationRepository,
      mcpServers: mcpServerRepository,
      creditTransactions: creditTransactionRepository,
      usageEvents: usageEventRepository,
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
            // any: RapidReplyResult update payload is schema-generic; typed upstream
            return await rapidReplyResultRepository.updateResult(id, data);
          },
          updateResultByQuestId: async (questId: string, data: any) => {
            // any: same as above
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
      imageModerationIncidents: imageModerationIncidentRepository,
    },
    storage: getFilesStorage(),
    imageGenerateStorage: getGeneratedImageStorage(),
    imageProcessorLambdaName: Resource.ImageProcessor.name,
    wsHttpsUrl: Resource.websocket.managementEndpoint,
    slackWebhookUrl: Config.SLACK_WEBHOOK_URL,
    abilityGetter: defineAbilitiesFor,
    getScopeFilter: (user: IUserDocument, permission: Permission, modelName: string) =>
      accessibleBy(defineAbilitiesFor(user), permission).ofType(mongoose.models[modelName]),
    // Entitlement-aware lake retrieval parity with questProcessor (see note there).
    getEntitlements: getUserEntitlements,
    autoNameSession: autoNameSessionAdapter,
    invokeCreateMemento: async (questId: string, sessionId: string, userId: string, prompt: string, model: string) => {
      await LLMEvents.CompletionCompleted.publish({
        questId,
        sessionId,
        userId,
        prompt,
        model,
      });
    },
    summarizeSession: summarizeSession,
    contextSummarizeSession: contextSummarizeSession,
    getMcpClient: getMcpClientAdapter,
    logEvent: logEvent,
    cacheRepository: cacheRepository,
    publishTelemetryAlert: publishTelemetryAlertCallback,
  };

  return cachedStaticOptions;
};

const getMcpClientAdapter = async (
  mcpServer: IMcpServerDocument
): Promise<{
  serverName: string;
  getTools: () => Promise<MCPClient['tools']>;
  // any: MCP tool args and return values are schema-defined at runtime, not statically typed
  callTool: (toolName: string, toolArgs: any) => Promise<any>;
}> => {
  const buildPayload = async (action: string, toolName?: string, toolArgs?: unknown) => ({
    id: mcpServer.id,
    envVariables: await buildMcpEnvVariables(mcpServer),
    name: mcpServer.name,
    action,
    toolName,
    toolArgs,
  });

  return {
    serverName: mcpServer.name,
    getTools: async () => {
      const payload = await buildPayload('getTools');
      return invokeMcpHandler<MCPClient['tools']>(payload);
    },
    callTool: async (toolName: string, toolArgs: any) => {
      // any: MCP tool args are schema-defined at runtime
      const payload = await buildPayload('callTool', toolName, toolArgs);
      return invokeMcpHandler(payload);
    },
  };
};

const autoNameSessionAdapter = async (sessionId: string, logger: Logger): Promise<string | null> => {
  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Session ${sessionId} not found for auto-naming`);
    return null;
  }

  try {
    logger.info(`[AUTO_NAME] Publishing auto-naming event for session ${sessionId}, userId: ${session.userId}`);
    await SessionEvents.AutoName.publish({
      sessionId,
      userId: session.userId,
    });
    logger.info(`[AUTO_NAME] Auto-naming event published successfully for session ${sessionId}`);
    return null;
  } catch (error) {
    logger.error(`[AUTO_NAME] Failed to publish auto-naming event for session ${sessionId}:`, error);
    throw error;
  }
};

/**
 * Format Slack response blocks from markdown text.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatSimpleAgentResponse(response: string): { blocks: any[] } {
  // any: Slack KnownBlock union type from @slack/web-api is not exported from @bike4mind/slack
  const { text } = processMarkdownForSlack(response);
  const { blocks } = splitTextIntoBlocks(text);
  return { blocks };
}

/**
 * Slack Quest Processor Lambda Handler
 *
 * Handles Slack-originated completion requests routed via SlackEventBus.
 * Always enables Slack tools (no enableSlackTools flag check needed).
 * Delivers the final AI response directly to Slack after processing,
 * replacing the async notification EventBridge hop.
 */
export const handler = withEventContext(async (event, logger) => {
  const handlerStartTime = Date.now();
  console.log('🌍 [SERVER] slack quest processor handler start:', new Date().toISOString());

  const params = LLMEvents.SlackCompletionStart.schema.parse(event.properties as unknown);

  if (!cachedDbConnection || mongoose.connection.readyState !== 1) {
    const dbStartTime = Date.now();
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
    cachedDbConnection = mongoose.connection;
    console.log(`⏱️ [TIMING] MongoDB connected (new): ${Date.now() - dbStartTime}ms`);
  } else {
    console.log(`♻️ [PERFORMANCE] Reusing existing DB connection (readyState: ${mongoose.connection.readyState})`);
  }

  const queryStartTime = Date.now();
  const [user, session] = await Promise.all([
    User.findById(params.userId),
    sessionRepository.findById(params.sessionId),
  ]);
  console.log(`⏱️ [TIMING] User and session queries completed: ${Date.now() - queryStartTime}ms`);

  if (!user) throw new NotFoundError('User not found');

  logger.updateMetadata({
    userId: params.userId,
    sessionId: params.sessionId,
    questId: params.questId,
  });

  if (!session) {
    await questRepository.update({
      id: params.questId,
      status: 'stopped',
      replies: ['Session not found. Please create a new session or refresh the page.'],
    });

    throw new NotFoundError('Session not found');
  }

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

  const optionsStartTime = Date.now();
  const staticOptions = getStaticOptions();
  const chatCompletion = new ChatCompletionProcess({
    ...staticOptions,
    logger,
    tokenizer: getSharedTokenizer(logger),
    sessionId: params.sessionId,
    user,
  });
  console.log(`⏱️ [TIMING] ChatCompletionProcess instantiation: ${Date.now() - optionsStartTime}ms`);

  const timeToProcess = Date.now() - handlerStartTime;
  console.log('🌍 [SERVER] slack quest processor call chatCompletion.process:', new Date().toISOString());
  console.log(`⏱️ [TIMING] Handler start to chatCompletion.process: ${timeToProcess}ms`);

  // Slack completions always get Slack tools - no enableSlackTools flag needed
  const baseTools: Record<string, ToolDefinition> = { ...slackToolDefinitions };

  if (requestBody.tools?.includes('confirm_pending_action')) {
    const pendingTools = createPendingActionToolDefs({
      sessionId: params.sessionId,
      executePendingAction,
      cancelPendingAction: cancelPendingActionOnQuest,
      findQuestWithPendingAction: (sessionId: string) =>
        Quest.findOne({ sessionId, pendingAction: { $exists: true } }).sort({ createdAt: -1 }),
      findUserById: (userId: string) => User.findById(userId),
    });
    Object.assign(baseTools, pendingTools);
  }

  // Register Lattice tool definitions as externalTools when the flag is set, so
  // the names appended inside ChatCompletionProcess actually resolve.
  // Premium overlay tool implementations merge first so explicit tools win.
  const externalTools = { ...premiumLlmTools, ...withLatticeTools(baseTools, requestBody.enableLattice) };

  await chatCompletion.process({
    body: requestBody,
    logger,
    externalTools,
  });

  // Inline Slack notification delivery - edits the status message with the final AI response
  // and uploads any generated images. Replaces the SlackNotificationEvents EventBridge hop.
  const quest = await Quest.findById(params.questId);

  if (!quest?.slackNotification) {
    return;
  }

  const { workspaceId, channelId, messageTs, threadTs, isPaintCommand } = quest.slackNotification as {
    workspaceId: string;
    channelId: string;
    messageTs: string;
    threadTs?: string;
    isPaintCommand?: boolean;
  };

  const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(workspaceId);
  if (!workspace) {
    logger.error('[SLACK-NOTIFY] Workspace not found', { workspaceId });
    // Best-effort: clear the stuck "Processing..." message so users aren't left hanging
    try {
      await Quest.findByIdAndUpdate(params.questId, { $unset: { slackNotification: 1 } });
    } catch (cleanupErr) {
      logger.warn('[SLACK-NOTIFY] Failed to clear slackNotification on missing workspace', { cleanupErr });
    }
    return;
  }
  if (!workspace.slackBotToken) {
    logger.error('[SLACK-NOTIFY] Workspace found but bot token is missing', {
      workspaceId,
      workspaceName: workspace.name,
    });
    try {
      await Quest.findByIdAndUpdate(params.questId, { $unset: { slackNotification: 1 } });
    } catch (cleanupErr) {
      logger.warn('[SLACK-NOTIFY] Failed to clear slackNotification on missing bot token', { cleanupErr });
    }
    return;
  }

  const decryptedToken = decryptToken(workspace.slackBotToken);
  if (!decryptedToken) {
    logger.error('[SLACK-NOTIFY] Failed to decrypt bot token', {
      workspaceId,
      workspaceName: workspace.name,
    });
    try {
      await Quest.findByIdAndUpdate(params.questId, { $unset: { slackNotification: 1 } });
    } catch (cleanupErr) {
      logger.warn('[SLACK-NOTIFY] Failed to clear slackNotification on decrypt failure', { cleanupErr });
    }
    return;
  }

  const slackClient = new SlackClient(decryptedToken, logger);

  const aiResponse = quest.reply || quest.replies?.[0] || 'Processing complete.';
  let formatted = formatSimpleAgentResponse(aiResponse);

  let displayText = aiResponse;
  if (quest.pendingAction && quest.pendingAction.tool !== 'image_generation') {
    const { tool, params: pendingParams } = quest.pendingAction;

    const formattedPreview = formatPreviewFromParams(tool, pendingParams as Record<string, unknown>);
    displayText = formattedPreview;
    formatted = formatSimpleAgentResponse(formattedPreview);

    const confirmButtons = buildConfirmationButtons(params.questId);
    formatted.blocks = [...formatted.blocks, ...confirmButtons];

    await Quest.findByIdAndUpdate(params.questId, {
      reply: formattedPreview,
      replies: [formattedPreview],
    });
  }

  if (quest.images?.length) {
    if (isPaintCommand && quest.prompt) {
      displayText = `🎨 *Prompt:* ${quest.prompt}`;
      if (aiResponse && aiResponse !== 'Processing complete.') {
        displayText += `\n\n${aiResponse}`;
      }
    }
    formatted = formatSimpleAgentResponse(displayText);
  }

  if (messageTs) {
    try {
      await slackClient.updateMessage({
        channel: channelId,
        ts: messageTs,
        text: displayText,
        blocks: formatted.blocks,
      });
    } catch (updateError) {
      logger.error('[SLACK-NOTIFY] Failed to update status message, continuing with image upload', {
        questId: params.questId,
        messageTs,
        error: updateError,
      });
    }
  }

  if (quest.images?.length) {
    logger.info('[SLACK-NOTIFY] Uploading generated images to Slack', {
      questId: params.questId,
      imageCount: quest.images.length,
      channelId,
    });

    for (const imagePath of quest.images) {
      try {
        const imageBuffer = await getGeneratedImageStorage().download(imagePath);
        const filename = imagePath.split('/').pop() || 'generated-image.png';
        await slackClient.uploadFile({
          channel: channelId,
          filename,
          content: imageBuffer,
          threadTs: threadTs || messageTs,
        });
        logger.info('[SLACK-NOTIFY] Image uploaded to Slack', { questId: params.questId, filename });
      } catch (imgError) {
        logger.error('[SLACK-NOTIFY] Failed to upload image to Slack', {
          questId: params.questId,
          imagePath,
          error: imgError,
        });
      }
    }
  }

  // Wrap cleanup in try-catch: if this fails after successful delivery, EventBridge would retry
  // the Lambda and the user would receive a duplicate notification.
  try {
    await Quest.findByIdAndUpdate(params.questId, { $unset: { slackNotification: 1 } });
  } catch (cleanupErr) {
    logger.error(
      '[SLACK-NOTIFY] Failed to clear slackNotification after delivery — duplicate notification risk on retry',
      {
        questId: params.questId,
        error: cleanupErr,
      }
    );
  }

  logger.info('[SLACK-NOTIFY] Slack notification delivered', { questId: params.questId });
});
