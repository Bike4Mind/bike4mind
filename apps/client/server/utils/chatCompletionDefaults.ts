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
  ChatModels,
  ContextTelemetry,
  ContextTelemetryAlerts,
  IMcpServerDocument,
  IUserDocument,
  ModelBackend,
  Permission,
  type ModelInfo,
} from '@bike4mind/common';
import { MCPClient } from '@bike4mind/mcp';
import { apiKeyService, IChatCompletionServiceOptions } from '@bike4mind/services';
import { ApiKeyTable, getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { getSettingsByNames, ITokenizer, TiktokenTokenizer } from '@bike4mind/utils';
import { ILogger, Logger } from '@bike4mind/observability';
import { accessibleBy } from '@casl/mongoose';
import { logEvent } from '@server/utils/analyticsLog';
import { recallMementosV2 } from '@server/memory/recallMementosV2';
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
    invokeCreateMemento: async (questId, sessionId, userId, prompt, model, flags): Promise<void> => {
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

/**
 * Whether `modelInfo` can actually serve a completion with these keys. `getLlmByModel`
 * returns null when the provider key is absent AND throws ('<provider> API key is expired')
 * when a stored key is past its expiry - both mean "not usable" here, so the throw is
 * swallowed rather than surfaced as a 500. Shared by the resolver's fallback decision and
 * chat.ts's no-usable-model guard so they agree on what "usable" means.
 */
export function isChatModelUsable(apiKeys: ApiKeyTable, modelInfo: ModelInfo | undefined, logger: Logger): boolean {
  if (!modelInfo) return false;
  try {
    return getLlmByModel(apiKeys, { modelInfo, logger }) !== null;
  } catch {
    return false;
  }
}

/**
 * Heuristic name match for an Ollama embedding model. The Ollama backend enumerates every
 * pulled model as type 'text', so an embedding model (e.g. nomic-embed-text) would otherwise
 * be a valid chat fallback and answer with empty replies. Matched by id against known
 * embedding families; kept deliberately narrow so a general model like gemma3 does NOT trip
 * the `embeddinggemma` term. Self-contained on purpose - do not couple to ollamaBackend.
 */
export function isLikelyEmbeddingModel(id: string): boolean {
  return /embed|bge-|bge:|minilm|arctic-embed|embeddinggemma/i.test(id);
}

export interface ResolvedDefaultChatModel {
  /** The model id to use when a request omits one. */
  model: string;
  /**
   * Effective API keys and the available-models list. Computed only on self-host
   * (undefined on hosted, where no per-request probing happens) and returned so the
   * caller can judge the model's usability without re-running the two lookups.
   */
  apiKeys?: ApiKeyTable;
  models?: ModelInfo[];
}

/**
 * Resolve the default chat model for a request that omits `model`.
 *
 * Hosted (B4M_SELF_HOST !== 'true'): the Bedrock-backed schema default is always
 * reachable via IAM, so return it directly with zero extra work.
 *
 * Self-host: Bedrock never works, so the schema default maps to its direct-API
 * Anthropic twin - but a local-only box may have no ANTHROPIC_API_KEY at all. Probe
 * the effective keys and the live model list, then keep the configured default when
 * its provider key is usable, else fall back to the first local Ollama chat model
 * (needs no key; embedding models are skipped), else return the (unusable) default so
 * the caller can raise a clear error. The live Ollama /api/tags list is the source of
 * truth for local models, not OLLAMA_PULL_MODELS.
 */
export async function resolveDefaultChatModel(params: {
  configuredModel: string | null | undefined;
  userId: string;
  logger?: Logger;
}): Promise<ResolvedDefaultChatModel> {
  const cloudDefault = params.configuredModel || ChatModels.CLAUDE_5_SONNET_BEDROCK;

  if (process.env.B4M_SELF_HOST !== 'true') {
    return { model: cloudDefault };
  }

  const configuredDefault =
    cloudDefault === ChatModels.CLAUDE_5_SONNET_BEDROCK ? ChatModels.CLAUDE_5_SONNET : cloudDefault;

  const logger = params.logger ?? new Logger();
  const apiKeys = (await apiKeyService.getEffectiveLLMApiKeys(
    params.userId,
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository }, getSettingsByNames },
    { logger }
  )) as ApiKeyTable;
  const models = await getAvailableModels(apiKeys);

  const configuredInfo = models.find(m => m.id === configuredDefault);
  if (isChatModelUsable(apiKeys, configuredInfo, logger) && !isLikelyEmbeddingModel(configuredDefault)) {
    return { model: configuredDefault, apiKeys, models };
  }

  // First local Ollama text model that is not an embedding model (those enumerate as 'text'
  // but produce no chat reply, e.g. nomic-embed-text pulled alongside a coder model).
  const localModel = models.find(
    m => m.backend === ModelBackend.Ollama && m.type === 'text' && !isLikelyEmbeddingModel(m.id)
  );
  if (localModel) {
    // No isChatModelUsable re-check on this pick: the route guard (chat.ts) re-validates via
    // isChatModelUsable, and an Ollama model is usable iff apiKeys.ollama is set - the same
    // condition under which getAvailableModels enumerates it into `models`. So any Ollama model
    // present here is already usable, and the guard and this fallback stay in agreement.
    return { model: localModel.id, apiKeys, models };
  }

  return { model: configuredDefault, apiKeys, models };
}
