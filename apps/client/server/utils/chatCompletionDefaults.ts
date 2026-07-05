import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  adminSettingsRepository,
  agentRepository,
  apiKeyRepository,
  cacheRepository,
  Connection,
  creditTransactionRepository,
  defineAbilitiesFor,
  fabFileChunkRepository,
  fabFileRepository,
  imageModerationIncidentRepository,
  latticeModelRepository,
  mcpServerRepository,
  mementoRepository,
  mongoose,
  organizationRepository,
  projectRepository,
  promptRepository,
  questMasterPlanRepository,
  questRepository,
  rapidReplyMappingRepository,
  rapidReplyResultRepository,
  Session,
  sessionRepository,
  skillRepository,
  usageEventRepository,
  userRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import {
  ContextTelemetry,
  ContextTelemetryAlerts,
  IMcpServerDocument,
  IUserDocument,
  Permission,
} from '@bike4mind/common';
import { MCPClient } from '@bike4mind/mcp';
import { IChatCompletionServiceOptions } from '@bike4mind/services';
import { ITokenizer, TiktokenTokenizer } from '@bike4mind/utils';
import { ILogger, Logger } from '@bike4mind/observability';
import { accessibleBy } from '@casl/mongoose';
import { logEvent } from '@server/utils/analyticsLog';
import { summarizeSession, contextSummarizeSession } from '@server/managers/sessionManager';
import { getUserEntitlements } from '@server/entitlements';
import { Config } from '@server/utils/config';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { Resource } from 'sst';
import { buildMcpEnvVariables } from '@server/utils/mcpEnv';
import { LLMEvents, TelemetryEvents } from '@server/utils/eventBus';

/**
 * Publish telemetry alert events to EventBridge for async processing.
 * The actual alert handling (Slack notification, GitHub issue creation, dedup)
 * is done by the dedicated telemetryAlert event handler Lambda.
 *
 * This ensures alerts complete even when the main request Lambda terminates.
 * Exported for use by QuestProcessor which handles async completions.
 */
export const publishTelemetryAlertCallback = async (args: {
  telemetry: ContextTelemetry;
  alertConfig: ContextTelemetryAlerts;
  requestId?: string;
}): Promise<void> => {
  await TelemetryEvents.Alert.publish({
    telemetry: args.telemetry,
    alertConfig: args.alertConfig,
    requestId: args.requestId,
  });
};

// Create an adapter for sessionService.autoName to publish event to EventBridge
const autoNameSessionAdapter = async (sessionId: string, logger: Logger): Promise<string | null> => {
  // Import SessionEvents dynamically to avoid circular dependencies
  const { SessionEvents } = await import('@server/utils/eventBus');

  // Get the session to determine the userId
  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Session ${sessionId} not found for auto-naming`);
    return null;
  }

  // Publish event to EventBridge for async processing
  try {
    await SessionEvents.AutoName.publish({
      sessionId,
      userId: session.userId,
    });
    logger.info(`Auto-naming event published for session ${sessionId}`);
    return null; // Return null as naming happens asynchronously now
  } catch (error) {
    logger.error(`Failed to publish auto-naming event for session ${sessionId}:`, error);
    throw error;
  }
};

type DefaultChatCompletionOptions = Omit<
  IChatCompletionServiceOptions,
  'user' | 'sessionId' | 'features' | 'logger' | 'tokenizer'
>;

// Memoized lazy factory.
//
// Previously a module-level `export const defaultChatCompletionOptions` evaluated
// `getFilesStorage()`, `getGeneratedImageStorage()`, `Resource.websocket.managementEndpoint`,
// and `Resource.SECRET_ENCRYPTION_KEY.value` at module load. Any Lambda whose link array
// omitted those resources crashed at cold start the moment something in the import chain
// pulled this file in (e.g. just to grab `getSharedTokenizer`).
//
// The factory below defers all Resource access to first invocation, matching the lazy
// pattern in `@server/utils/storage` and the queueHandler service factories. Memoization
// preserves the prior reference-equality semantics for callers that spread the object.
let _defaultChatCompletionOptions: DefaultChatCompletionOptions | undefined;

export const getDefaultChatCompletionOptions = (): DefaultChatCompletionOptions => {
  if (_defaultChatCompletionOptions) return _defaultChatCompletionOptions;
  _defaultChatCompletionOptions = {
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
      latticeModels: latticeModelRepository,
      // Audit trail for images blocked by the image_generation/edit_image tools'
      // moderation gate. The gate itself is unconditional (constructed inline
      // in the tool) - this only wires the incident record, not the block.
      imageModerationIncidents: imageModerationIncidentRepository,
    },
    storage: getFilesStorage(),
    imageGenerateStorage: getGeneratedImageStorage(),
    wsHttpsUrl: Resource.websocket.managementEndpoint,
    slackWebhookUrl: Config.SLACK_WEBHOOK_URL,
    // Queue is NOT included here - consumers must create SQSService per-request
    // to avoid credential expiration issues.
    // @deprecated: Use scope instead
    abilityGetter: defineAbilitiesFor,
    getScopeFilter: (user: IUserDocument, permission: Permission, modelName: string) =>
      accessibleBy(defineAbilitiesFor(user), permission).ofType(mongoose.models[modelName]),
    // Resolve entitlement keys so ALL chat surfaces (chat/opti/voice/ai-llm/rapid-reply/slack)
    // reach entitlement-gated lakes - a tag-less subscriber gets the SAME lake access a
    // comp-tag holder already gets here, closing the Q3b asymmetry on the generic surfaces
    // (not just the libonc Tutor). Pure fn ref; per-request resolution is memoized in core.
    getEntitlements: getUserEntitlements,
    autoNameSession: autoNameSessionAdapter,
    invokeCreateMemento: async (questId, sessionId, userId, prompt, model): Promise<void> => {
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
    getMcpClient: async (
      mcpServer: IMcpServerDocument
    ): Promise<{
      serverName: string;
      getTools: () => Promise<MCPClient['tools']>;
      callTool: (toolName: string, toolArgs: any) => Promise<any>;
    }> => {
      return {
        serverName: mcpServer.name,
        getTools: async () => {
          // Create fresh LambdaClient per-call to prevent credential expiration in warm containers
          const client = new LambdaClient({});

          const envVariables = await buildMcpEnvVariables(mcpServer);
          const command = new InvokeCommand({
            FunctionName: Resource.mcpHandler.name,
            Payload: JSON.stringify({
              id: mcpServer.id,
              envVariables,
              name: mcpServer.name,
              action: 'getTools',
              userId: mcpServer.userId,
            }),
            InvocationType: 'RequestResponse',
          });
          const response = await client.send(command);
          const result = JSON.parse(Buffer.from(response.Payload || '').toString());
          return result as MCPClient['tools'];
        },
        callTool: async (toolName: string, toolArgs: any) => {
          // Create fresh LambdaClient per-call to prevent credential expiration in warm containers
          const client = new LambdaClient({});

          const envVariables = await buildMcpEnvVariables(mcpServer);
          const command = new InvokeCommand({
            FunctionName: Resource.mcpHandler.name,
            Payload: JSON.stringify({
              id: mcpServer.id,
              envVariables,
              name: mcpServer.name,
              action: 'callTool',
              toolName,
              toolArgs,
              userId: mcpServer.userId,
            }),
            InvocationType: 'RequestResponse',
          });

          const response = await client.send(command);
          const result = JSON.parse(Buffer.from(response.Payload || '').toString());
          return result;
        },
      };
    },
    logEvent: logEvent,
    cacheRepository: cacheRepository,
    publishTelemetryAlert: publishTelemetryAlertCallback,
    telemetryHmacSecret: Resource.SECRET_ENCRYPTION_KEY.value,
  };
  return _defaultChatCompletionOptions;
};

// PERFORMANCE: Module-level singleton tokenizer that persists across Lambda warm invocations.
// The WASM tiktoken encoder cache is reused across requests, avoiding repeated encoder creation
// and preventing WASM memory leaks from un-freed encoders.
const tokenizerLogger = new Logger({ metadata: { component: 'tokenizer' } });
let sharedTokenizer: TiktokenTokenizer | null = null;

/**
 * Returns the shared tokenizer singleton. When a request-scoped logger is provided,
 * returns a lightweight proxy that delegates WASM encoder ops to the singleton (preserving
 * the encoder cache) but routes log output through a child of the provided logger enriched
 * with `{ component: 'tokenizer' }`. This means tokenizer logs carry full request context
 * (requestId, userId, etc.) without sacrificing the singleton WASM encoder benefit.
 */
export function getSharedTokenizer(logger?: ILogger): ITokenizer {
  if (!sharedTokenizer) {
    sharedTokenizer = new TiktokenTokenizer({ logger: tokenizerLogger });
  }
  if (logger) {
    const enrichedLogger = logger.withMetadata?.({ component: 'tokenizer' }) ?? logger;
    return sharedTokenizer.withLogger(enrichedLogger);
  }
  return sharedTokenizer;
}
