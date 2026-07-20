import {
  ChatCompletionCreateInput,
  ChatCompletionCreateInputSchema,
  ChatModels,
  ContextTelemetry,
  ContextTelemetryAlerts,
  IConnection,
  IChatHistoryItemDocument,
  IMessage,
  IOrganizationDocument,
  IProjectDocument,
  ISessionDocument,
  IUserDocument,
  LLMEvents,
  ModelInfo,
  Permission,
  QuestMasterParamsSchema,
  IAgentRepository,
  ISkillRepository,
  IChatHistoryItemRepository,
  IFabFileChunkRepository,
  IFabFileRepository,
  IProjectRepository,
  ISessionRepository,
  IUserRepository,
  IAdminSettingsRepository,
  IMcpServerRepository,
  IMcpServerDocument,
  IQuestMasterPlanRepository,
  IPromptDocument,
  ICacheRepository,
  ICreditTransactionRepository,
  IUsageEventRepository,
  IMementoRepository,
  IOrganizationRepository,
  DashboardParamsSchema,
  PromptMetaZodSchema,
  b4mLLMTools,
  ResearchModeParamsSchema,
  GenerateImageToolCallSchema,
  ILatticeModel,
  IDataLakeRepository,
  IFabFileChunkDocument,
  CitableSource,
  OpenAIEmbeddingModel,
  SupportedEmbeddingModel,
  ImageModerationIncident,
  isExperimentalFeatureEnabled,
  buildMemoryContext,
} from '@bike4mind/common';
import { getDynamicDataLakeAccess } from '../dataLakeService/getDynamicDataLakeTags';
import { getRelevantMementos } from '../mementoService';
import {
  BaseStorage,
  computeCosineSimilarity,
  EmbeddingFactory,
  fetchAndProcessPreviousMessages,
  IQueueService,
  ITokenizer,
  postMessageToSlack,
  QuestMaster,
} from '@bike4mind/utils';
import { filterRetrievalExcluded, type RetrievalExclusionOptions } from '@bike4mind/utils/retrievalExclusion';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { MongoAbility } from '@casl/ability';
import mongoose from 'mongoose';
import { z } from 'zod';
import { GetEffectiveApiKeyAdapters } from '@bike4mind/auth/apiKeyService';
import { ChatCompletionProcess } from './ChatCompletionProcess';
import { MCPClient } from '@bike4mind/mcp';
import uniq from 'lodash/uniq.js';

interface DatabaseAdapters {
  sessions: Pick<ISessionRepository, 'findById' | 'findAllByIds' | 'update' | 'attachAgent'>;
  users: Pick<
    IUserRepository,
    'findById' | 'update' | 'incrementCredits' | 'recordModerationHit' | 'setModerationStatus'
  >;
  quests: IChatHistoryItemRepository;
  questMasterPlans: IQuestMasterPlanRepository;
  connections: {
    findByUserId(userId: string): Promise<IConnection[]>;
    deleteByConnectionId(connectionId: string): Promise<void>;
  };
  adminSettings: IAdminSettingsRepository;
  fabfiles: IFabFileRepository;
  fabfilechunks: Pick<IFabFileChunkRepository, 'findByFabFileId' | 'findVectorsByFabFileIds'>;
  mementos: IMementoRepository;
  projects: IProjectRepository;
  organizations: IOrganizationRepository;
  mcpServers: IMcpServerRepository;
  creditTransactions?: ICreditTransactionRepository;
  /** Optional usage-event sink: dual-write analytics, never billing. */
  usageEvents?: IUsageEventRepository;
  agents: IAgentRepository;
  /**
   * Optional skill repository - present when the host wires `/api/skills`
   * persistence into ChatCompletionProcess. Used by SkillsFeature to expand
   * `/skill-name args` invocations into the system prompt. Optional so older
   * callers / tests that don't construct a skill store still type-check.
   */
  skills?: Pick<
    ISkillRepository,
    | 'findById'
    | 'findByNameForUser'
    | 'findByNamesForUser'
    | 'findAccessibleByNameForUser'
    | 'findAccessibleByNamesForUser'
    | 'listForUser'
    | 'listInvocableForUser'
    | 'listAccessibleInvocableForUser'
    | 'listForOrganization'
    | 'listSystem'
    | 'searchAccessible'
  >;
  caches: ICacheRepository;
  prompts: {
    findById: (id: string) => Promise<IPromptDocument | null>;
  };
  rapidReply?: {
    results: {
      createResult: (data: any) => Promise<any>;
      updateResult: (id: string, data: any) => Promise<any>;
      updateResultByQuestId: (questId: string, data: any) => Promise<any>;
      findByQuestId: (questId: string) => Promise<any>;
      findLatestBlankRapidReplyBySessionId: (sessionId: string) => Promise<any>;
    };
    mappings: any;
    settings: {
      getSettings: () => Promise<any>;
    };
  };
  latticeModels?: {
    create: (data: any) => Promise<ILatticeModel>;
    findById: (id: string) => Promise<ILatticeModel | null>;
    update: (data: any) => Promise<ILatticeModel | null>;
  };
  dataLakes?: Pick<IDataLakeRepository, 'findActiveByUserTags' | 'findActiveByUserTagsAndEntitlements'>;
  /**
   * Audit-trail repo for images blocked by the image_generation/edit_image tools'
   * moderation gate. Optional - the gate itself is unconditional (the tools
   * construct RekognitionImageModerationService inline); a missing repo only drops the
   * incident audit record, not the block.
   */
  imageModerationIncidents?: { record(input: ImageModerationIncident): Promise<unknown> };
}
export type featureNames =
  | 'slack'
  | 'mementos'
  | 'questMaster'
  | 'autoNameSession'
  | 'project'
  | 'summarizeNotebook'
  | 'agentDetection'
  | 'organizationPrompt'
  | 'sessionPrompt'
  | 'knowledgeRetrieval'
  | 'contextSummarization'
  | 'skills';
export interface IChatCompletionServiceOptions {
  db: DatabaseAdapters & GetEffectiveApiKeyAdapters['db'];
  storage: BaseStorage;
  imageGenerateStorage: BaseStorage;
  queue?: IQueueService;
  wsHttpsUrl: string;
  slackWebhookUrl: string;
  imageProcessorLambdaName?: string; // Lambda function name for image processing
  abilityGetter: (user: IUserDocument | undefined) => MongoAbility;
  autoNameSession: (sessionId: string, logger: Logger) => Promise<string | null>;
  invokeCreateMemento: (
    questId: string,
    sessionId: string,
    userId: string,
    prompt: string,
    model: string,
    // The RESOLVED write flags. Chat must forward these the same way the agent path does, or the
    // memento subscriber defaults writeV1=true and force-writes a V1 memento on every turn even when
    // V1 is off - the concrete thing that kept V1 un-deletable.
    flags: { enableMementos: boolean; enableMementosV2: boolean }
  ) => Promise<void>;
  /**
   * Mementos V2 retrieval, injected by the app tier (b4m-core cannot reach the ledger store). For a
   * user on V2 it returns the beliefs to inject for `query` (the ledger unioned with their V1
   * mementos, recalled); for a user on V1 it returns null so the caller keeps the classic memento
   * path. Optional so callers that do not wire it fall back to V1.
   */
  /**
   * `enabled` lets the caller hand over the V2 opt-in it has ALREADY resolved from the in-hand user
   * document, so the recall does not re-fetch the user just to re-read a flag - a wasted remote-DB
   * round trip (~100ms) on the critical path of every chat turn. Omitted, the recall looks it up.
   */
  recallMementosV2?: (
    userId: string,
    query: string,
    opts?: { enabled?: boolean }
  ) => Promise<{ fact: string; relevance: number }[] | null>;
  summarizeSession: (sessionId: string, trigger: ISessionDocument['summaryTrigger']) => Promise<void>;
  contextSummarizeSession: (sessionId: string, verbatimWindowStartQuestId: string) => Promise<void>;
  getMcpClient: (server: IMcpServerDocument) => Promise<{
    serverName: string;
    getTools: () => Promise<MCPClient['tools']>;
    callTool: (toolName: string, toolArgs: any) => Promise<any>;
  }>;
  logEvent: (event: any, options?: { session?: mongoose.ClientSession; ability?: MongoAbility }) => Promise<any>;
  logger: Logger;
  getScopeFilter: (user: IUserDocument, permission: Permission, modelName: string) => Record<string, unknown>;
  /**
   * Generic capability: resolve the caller's entitlement keys (subscription- + tag-derived,
   * incl. any product gate parity the app applies). Injected by the app tier - same pattern
   * as `abilityGetter`/`getScopeFilter` - so b4m-core consumes entitlement-derived access
   * WITHOUT importing the app-tier resolver or the Subscription model. Used to gate
   * entitlement-scoped data lakes in retrieval. Omitted -> no keys -> tag-only matching.
   */
  getEntitlements?: (user: IUserDocument) => Promise<string[]>;
  /**
   * Perform any cleanup or additional processing after the quest is completed.
   */
  onComplete?: (args: { queue: IQueueService; sessionId: string; logger: Logger }) => Promise<void>;
  /**
   * Optional callback fired during streaming with the latest accumulated visible
   * reply text (the answer item, after any thinking reply). The Voice v2 proxy
   * uses this to forward token deltas to ElevenLabs as an SSE stream instead of
   * buffering the whole reply - which keeps ElevenLabs under its time-to-first-token
   * timeout. Called on each throttled send and once on completion.
   */
  onReplyStream?: (fullReplyText: string) => void;
  /**
   * Optional callback fired BEFORE a tool's `toolFn` runs, with a short
   * pre-resolved preamble string ("Searching the web..."). The Voice v2 proxy uses
   * this to speak the preamble via the SSE stream while the tool executes, since
   * ElevenLabs' time-to-first-token timer keeps running during tool calls.
   * Out-of-band from `onReplyStream` - the preamble is not part of the LLM's
   * reply and must not advance the reply-diff baseline.
   */
  onToolPreamble?: (preamble: string, toolName: string) => void;
  /** Optional callback to invoke the quest processor Lambda function. */
  invokeLambda?: (params: z.infer<typeof QuestStartBodySchema>) => Promise<void>;
  user: IUserDocument;
  features?: Map<featureNames, ChatCompletionFeature>;
  sessionId: string;
  tokenizer: ITokenizer;
  /**
   * Optional cache repository for distributed deduplication.
   * Used by AnomalyAlertService for cross-instance alert dedup in serverless environments.
   */
  cacheRepository?: ICacheRepository;
  /**
   * Optional callback to publish telemetry alert events to EventBridge.
   * When provided, alerts are processed asynchronously by a dedicated Lambda,
   * ensuring alert delivery even when the main request Lambda terminates.
   * The callback publishes to EventBridge which triggers the telemetryAlert handler to:
   * - Send Slack alerts when anomaly score exceeds alertThreshold
   * - Auto-create GitHub issues when score exceeds criticalThreshold (if enabled)
   */
  publishTelemetryAlert?: (args: {
    telemetry: ContextTelemetry;
    alertConfig: ContextTelemetryAlerts;
    requestId?: string; // Quest ID for correlation
  }) => Promise<void>;
  /**
   * Secret key for deriving daily telemetry salts via HMAC.
   * Reuses SECRET_ENCRYPTION_KEY - no dedicated secret needed.
   * When undefined, falls back to a deterministic placeholder (dev-only).
   */
  telemetryHmacSecret?: string;
  /**
   * Whether the Global Privacy Control (GPC) signal was detected in the request.
   * When true, telemetry capture is skipped for this request regardless of user preference.
   * Required by CCPA/CPRA regulations effective January 1, 2026.
   */
  gpcSignalDetected?: boolean;
}

export const QuestStartBodySchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  questId: z.string(),
  message: z.string().min(1, 'Message cannot be empty'),
  messageFileIds: z.array(z.string()),
  historyCount: z.number(),
  fabFileIds: z.array(z.string()),
  params: ChatCompletionCreateInputSchema,
  dashboardParams: DashboardParamsSchema.optional(),
  enableQuestMaster: z.boolean().optional(),
  enableMementos: z.boolean().optional(),
  enableArtifacts: z.boolean().optional(),
  enableAgents: z.boolean().optional(),
  enableLattice: z.boolean().optional(),
  promptMeta: PromptMetaZodSchema,
  tools: z.array(z.union([b4mLLMTools, z.string()])).optional(),
  mcpServers: z.array(z.string()).optional(),
  projectId: z.string().optional(),
  organizationId: z.string().nullable().optional(),
  questMaster: QuestMasterParamsSchema.optional(),
  toolPromptId: z.string().optional(),
  researchMode: ResearchModeParamsSchema.optional(),
  fallbackModel: z.string().optional(),
  embeddingModel: z.string().optional(),
  queryComplexity: z.string(),
  imageConfig: GenerateImageToolCallSchema.optional(),
  deepResearchConfig: z
    .object({
      maxDepth: z.number().optional(),
      duration: z.number().optional(),
      // searchers are passed via ToolContext, not through this API schema
      searchers: z.array(z.any()).optional(),
    })
    .optional(),
  extraContextMessages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'function', 'tool']),
        content: z.union([z.string(), z.array(z.any())]),
        fabFileIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
  /** User's timezone (IANA format, e.g., "America/New_York") */
  timezone: z.string().optional(),
  /** Persona-based sub-agent filter - only these agent names are available for delegation */
  allowedAgents: z.array(z.string()).optional(),
  /** When true, Quest Processor injects Slack-specific tool configs (help, notebooks, curated files) */
  enableSlackTools: z.boolean().optional(),
});

// Type for what features need from the chat completion service
export type ChatCompletionContext = Pick<
  ChatCompletionProcess,
  | 'user'
  | 'slackWebhookUrl'
  | 'userAbility'
  | 'autoNameSession'
  | 'invokeCreateMemento'
  | 'recallMementosV2'
  | 'logEvent'
  | 'db'
  | 'sessionId'
  | 'summarizeSession'
  | 'contextSummarizeSession'
  | 'logger'
  | 'entitlementKeys'
  | 'resolveEntitlementKeys'
> & {
  sendStatusUpdate: (
    q: IChatHistoryItemDocument,
    status: string | null,
    options?: {
      statusAt?: Date;
      immediate?: boolean;
      silent?: boolean;
      skipPayloadOptimization?: boolean;
    }
  ) => Promise<void>;
  fabFilesToMessages: (
    fabFileIds: string[],
    quest: IChatHistoryItemDocument,
    embeddingFactory: EmbeddingFactory,
    message: string,
    max_tokens: number,
    modelInfo: ModelInfo
  ) => Promise<{ promptMessages: IMessage[]; convertedFabFiles: any[] }>;
};

export interface ChatCompletionFeature {
  onComplete(args: {
    quest: IChatHistoryItemDocument;
    session: ISessionDocument;
    messages: IMessage[];
    questMaster: z.infer<typeof QuestMasterParamsSchema> | undefined;
    model: string;
    historyCount?: number;
    oldestIncludedQuestId?: string | null;
  }): Promise<void>;
  beforeDataGathering: (args: {
    quest: IChatHistoryItemDocument;
    session: ISessionDocument;
    startParams: z.infer<typeof ChatCompletionCreateInputSchema>;
    llm: ICompletionBackend;
    model: string;
    message: string;
    historyCount: number;
    fabFileIds: string[];
    questId: string;
    questMaster: z.infer<typeof QuestMasterParamsSchema> | undefined;
  }) => Promise<{ shouldContinue: boolean }>;
  getContextMessages: (
    quest: IChatHistoryItemDocument,
    embeddingFactory: EmbeddingFactory,
    message: string,
    max_tokens: number,
    modelInfo: ModelInfo
  ) => Promise<IMessage[]>;
}

export class MementoFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private db: IChatCompletionServiceOptions['db'];
  private logger: Logger;
  private user: IUserDocument;
  private usedMementoIds: string[] = [];
  // Which pipelines this turn should WRITE to, resolved once at construction (where the admin gate and
  // the per-user opt-in are both in scope) and forwarded on completion - never re-defaulted downstream.
  private writeV1: boolean;
  private writeV2: boolean;

  constructor(chatCompletion: ChatCompletionContext, writeFlags: { writeV1: boolean; writeV2: boolean }) {
    this.chatCompletion = chatCompletion;
    this.writeV1 = writeFlags.writeV1;
    this.writeV2 = writeFlags.writeV2;
    this.db = chatCompletion.db;
    this.logger = chatCompletion.logger;
    this.user = chatCompletion.user;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(
    quest: IChatHistoryItemDocument,
    embeddingFactory: EmbeddingFactory,
    message: string,
    max_tokens: number,
    modelInfo: ModelInfo
  ): Promise<IMessage[]> {
    // Mementos V2: if this user is on V2, inject the ledger-unioned-with-mementos recall and skip
    // the V1 path (the two are mutually exclusive). A null result means the user is on V1.
    //
    // The opt-in is resolved HERE, off the user document we already hold - the recall would
    // otherwise re-fetch the user from the remote DB just to re-read the same flag, ~100ms of dead
    // time on every chat turn. Must use the Map-aware reader: the bag is a Mongoose Map.
    const isV2 = isExperimentalFeatureEnabled(this.user, 'enableMementosV2');
    if (isV2 && this.chatCompletion.recallMementosV2) {
      const v2 = await this.chatCompletion.recallMementosV2(this.user.id, message, { enabled: true });
      if (v2 !== null) {
        this.usedMementoIds = [];
        this.logger.log(`[Mementos V2] injecting ${v2.length} belief(s) into context`);
        // ONE framed system block, not one note-card per fact - see buildMemoryContext. Injecting each
        // belief as its own `[Memory] ...` message is what made the model recite its memory.
        const context = buildMemoryContext(v2.map(({ fact }) => fact));
        return context ? [{ role: 'system' as const, content: context }] : [];
      }
    }

    this.logger.log('📚 Retrieving relevant mementos using vector similarity');

    const relevantMementos = await getRelevantMementos(
      this.user.id,
      message,
      {
        topK: 10,
        minSimilarity: 0.75,
        embeddingModel: embeddingFactory.getDefaultEmbeddingModel(),
        logger: this.logger,
      },
      {
        db: {
          mementos: this.db.mementos,
          apiKeys: this.db.apiKeys,
          adminSettings: this.db.adminSettings,
        },
      }
    );

    if (relevantMementos.length === 0) {
      this.logger.log('• No relevant mementos found above similarity threshold');
      this.usedMementoIds = [];
      return [];
    }

    const topMemento = relevantMementos[0];
    this.logger.log(
      `• Most relevant: "${topMemento.memento.summary}" (${(topMemento.similarity * 100).toFixed(1)}% similar)`
    );

    // Store memento IDs for later tracking in onComplete
    this.usedMementoIds = relevantMementos.map(({ memento }) => memento.id);

    const contextMessages: IMessage[] = relevantMementos.map(({ memento, similarity }) => ({
      role: 'system',
      content: `[Memory - ${(similarity * 100).toFixed(0)}% relevant] ${memento.summary}`,
    }));

    this.logger.log(`• Added ${contextMessages.length} relevant memories to context\n`);

    return contextMessages;
  }

  async onComplete({ quest, model }: { quest: IChatHistoryItemDocument; model: string }): Promise<void> {
    const { userAbility } = this.chatCompletion;
    if (!userAbility) throw new Error('User ability not found');

    if (this.usedMementoIds.length > 0) {
      quest.promptMeta!.context!.mementoIds = this.usedMementoIds;

      this.logger.log(`• Tracked ${this.usedMementoIds.length} mementos used in quest ${quest.id}`);
    }

    await this.chatCompletion.invokeCreateMemento(quest.id, quest.sessionId, this.user.id, quest.prompt, model, {
      enableMementos: this.writeV1,
      enableMementosV2: this.writeV2,
    });
  }
}

export class SlackFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private user: IUserDocument;

  constructor(chatCompletion: ChatCompletionContext) {
    this.chatCompletion = chatCompletion;
    this.user = chatCompletion.user;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(): Promise<IMessage[]> {
    return [];
  }

  async onComplete({ quest }: { quest: IChatHistoryItemDocument }): Promise<void> {
    if (this.user.tags && this.user.tags.includes('debugLLMendpoint')) {
      const questReplies = (quest.replies || [])[0];
      if (!questReplies) return; // Guard against empty replies
      const opening = questReplies.substring(0, 400);
      const closing = questReplies.substring(questReplies.length - 400, questReplies.length);
      await postMessageToSlack(
        this.chatCompletion.slackWebhookUrl,
        `Bike4Mind replied to *${this.user.name}* with this response:\n${opening}...\n...\n...${closing}`
      );
    }
  }
}

export class AutoNameSessionFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private logger: Logger;
  private user: IUserDocument;
  private numAutoNameSessionsTrigger: number;

  constructor(chatCompletion: ChatCompletionContext, numAutoNameSessionsTrigger: number) {
    this.chatCompletion = chatCompletion;
    this.logger = chatCompletion.logger;
    this.user = chatCompletion.user;
    this.numAutoNameSessionsTrigger = numAutoNameSessionsTrigger;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(): Promise<IMessage[]> {
    return [];
  }

  async onComplete({
    quest,
    session,
    messages,
  }: {
    quest: IChatHistoryItemDocument;
    session: ISessionDocument;
    messages: IMessage[];
  }): Promise<void> {
    const userAbility = this.chatCompletion.userAbility;
    if (!userAbility) throw new Error('User ability not found');
    const conversationMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const conversationCount = Math.round(conversationMessages.length / 2);
    if (session.isAutoNamed && conversationMessages.length !== 1) {
      return;
    }
    try {
      // Publish to EventBridge; the event handler performs the actual auto-naming async
      await this.chatCompletion.autoNameSession(session.id, this.logger);
      this.logger.info(`[AUTO_NAME_FEATURE] Auto-naming event published for session ${session.id}`);

      await this.chatCompletion.logEvent(
        {
          userId: this.user.id,
          type: LLMEvents.QUEUE_HANDLER_START_AUTO_NAMED_SESSION,
          metadata: {
            sessionId: session.id,
            questId: quest.id,
            autoNameSessionTriggerThreshold: this.numAutoNameSessionsTrigger,
            conversationCount,
          },
        },
        { ability: userAbility }
      );
    } catch (error) {
      this.logger.error('Failed to publish auto-naming event:', error);
      await this.chatCompletion
        .logEvent(
          {
            userId: this.user.id,
            type: LLMEvents.AUTO_NAMING_ERROR,
            metadata: {
              sessionId: session.id,
              questId: quest.id,
              error: (error as Error).message,
              autoNameSessionTriggerThreshold: this.numAutoNameSessionsTrigger,
              conversationCount,
            },
          },
          { ability: userAbility }
        )
        .catch(err => this.logger.error('Failed to log auto-naming error event:', err));
    }
  }
}

export class QuestMasterFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private logger: Logger;
  private user: IUserDocument;

  constructor(chatCompletion: ChatCompletionContext) {
    this.chatCompletion = chatCompletion;
    this.logger = chatCompletion.logger;
    this.user = chatCompletion.user;
  }

  async getContextMessages(): Promise<IMessage[]> {
    // The real QuestMaster system prompt is handled in createQuestPlan
    return [];
  }

  async beforeDataGathering({
    quest,
    session,
    startParams,
    llm,
    model,
    message,
    historyCount,
    fabFileIds,
    questId,
    questMaster,
  }: {
    quest: IChatHistoryItemDocument;
    session: ISessionDocument;
    startParams: z.infer<typeof ChatCompletionCreateInputSchema>;
    llm: ICompletionBackend;
    model: string;
    message: string;
    historyCount: number;
    fabFileIds: string[];
    questId: string;
    questMaster: z.infer<typeof QuestMasterParamsSchema> | undefined;
  }): Promise<{ shouldContinue: boolean }> {
    // If questMaster is provided, that means we are to process a task from a QuestMaster plan
    if (questMaster) {
      await this.processQuestMasterTask(quest, questMaster);

      return { shouldContinue: true };
    }

    // Check if the model is compatible with QuestMaster
    // Some models may not follow XML/JSON formatting instructions reliably
    const incompatibleModels = [
      // O-series reasoning models (don't support tool calling in streaming mode)
      ChatModels.O1,
      ChatModels.O1_PREVIEW,
      ChatModels.O1_MINI,
      ChatModels.O3_MINI,
      // GPT-5 models WITHOUT tool support (supportsTools: false)
      // Other GPT-5 models now use function calling via questMaster.ts
      ChatModels.GPT5_CHAT_LATEST,
      ChatModels.GPT5_1_CHAT_LATEST,
      ChatModels.GPT5_2_CHAT_LATEST,
    ];

    if (incompatibleModels.includes(model as ChatModels)) {
      this.logger.log(
        `QuestMaster: Skipping for model ${model} as it may not be fully compatible with structured JSON output`
      );
      return { shouldContinue: true };
    }

    try {
      quest.status = 'running';
      quest.type = 'message';
      await this.chatCompletion.db.quests.update(quest);

      await this.chatCompletion.sendStatusUpdate(quest, 'Generating QuestMaster plan...');

      await this.sendQuestMasterRapidReply(quest, message);

      // Fetch conversation history to provide context for quest plan generation
      const [conversationHistory] = await fetchAndProcessPreviousMessages(session, historyCount, {
        db: this.chatCompletion.db,
      });

      this.logger.log(`QuestMaster: Fetched ${conversationHistory.length} history messages for context`);

      await this.questMasterRequest(quest, llm, model, startParams, quest.sessionId, message, conversationHistory);

      // Refetch to verify the questMasterReply was set
      const updatedQuest = await this.chatCompletion.db.quests.findById(questId);
      if (!updatedQuest) throw new Error('Quest not found after processing');

      await this.chatCompletion.sendStatusUpdate(updatedQuest, 'QuestMaster plan generated');

      this.logger.log('QuestMaster processing result:', {
        questMasterReply: updatedQuest.questMasterReply,
        reply: updatedQuest.reply,
      });

      updatedQuest.status = 'done';
      await this.chatCompletion.db.quests.update(updatedQuest);

      await this.chatCompletion.sendStatusUpdate(updatedQuest, null);

      // Return false so normal processing is skipped
      return { shouldContinue: false };
    } catch (error) {
      this.logger.error('Error in QuestMaster processing:', error);

      quest.type = 'error';
      quest.status = 'done';
      quest.reply = (error as Error).message;
      await this.chatCompletion.db.quests.update(quest);

      // Let normal processing continue
      return { shouldContinue: true };
    }
  }

  async onComplete({
    quest,
    questMaster,
  }: {
    quest: IChatHistoryItemDocument;
    questMaster: z.infer<typeof QuestMasterParamsSchema> | undefined;
  }): Promise<void> {
    if (!questMaster) return;

    const questMasterPlan = await this.chatCompletion.db.questMasterPlans.findById(questMaster.questMasterPlanId);
    if (!questMasterPlan) {
      this.logger.warn(`QuestMaster plan with id ${questMaster.questMasterPlanId} not found`);
      return;
    }

    const mainQuest = questMasterPlan.quests.find(t => t.id === questMaster.questId);
    if (!mainQuest) {
      this.logger.warn(
        `Main quest with id ${questMaster.questId} not found in QuestMaster plan with id ${questMaster.questMasterPlanId}`
      );
      return;
    }

    await this.chatCompletion.db.questMasterPlans.updateTaskStatus(
      questMaster.questMasterPlanId,
      questMaster.questId,
      questMaster.subQuestId,
      'completed'
    );
  }

  private readonly processQuestMasterTask = async (
    quest: IChatHistoryItemDocument,
    questMaster: z.infer<typeof QuestMasterParamsSchema>
  ) => {
    const questMasterPlan = await this.chatCompletion.db.questMasterPlans.findById(questMaster.questMasterPlanId);
    if (!questMasterPlan) {
      this.logger.warn(`QuestMaster plan with id ${questMaster.questMasterPlanId} not found`);
      return;
    }

    const subQuest = await this.chatCompletion.db.questMasterPlans.getSubQuest(
      questMaster.questMasterPlanId,
      questMaster.questId,
      questMaster.subQuestId
    );
    if (!subQuest) {
      this.logger.warn(
        `Sub quest with id ${questMaster.subQuestId} not found in QuestMaster plan with id ${questMaster.questMasterPlanId} for main quest with id ${questMaster.questId}`
      );
      return;
    }

    // Only skip if already completed or explicitly skipped - allow other statuses to proceed
    // This fixes the freeze issue where UI sets in_progress before LLM call, causing silent return
    if (subQuest.status === 'completed' || subQuest.status === 'skipped') {
      this.logger.log(
        `Sub quest ${questMaster.subQuestId} for main quest ${questMaster.questId} is ${subQuest.status}. Skipping.`
      );
      return;
    }

    // Log if we're re-processing an in_progress task (e.g., after page refresh)
    if (subQuest.status === 'in_progress') {
      this.logger.log(
        `Sub quest ${questMaster.subQuestId} for main quest ${questMaster.questId} is already in_progress. Re-processing.`
      );
    }

    // 'blocked' is not a valid SubQuestStatus in the type system.
    // SubQuestStatus allows: 'not_started' | 'in_progress' | 'completed' | 'skipped' | 'deleted'
    // Tasks with status 'not_started' or 'deleted' will proceed to processing here.

    this.logger.log(
      `Started sub quest ${questMaster.subQuestId} for main quest ${questMaster.questId} in QuestMaster plan ${questMaster.questMasterPlanId}`
    );

    await this.chatCompletion.db.questMasterPlans.updateTaskStatus(
      questMaster.questMasterPlanId,
      questMaster.questId,
      questMaster.subQuestId,
      'in_progress'
    );
  };

  private async questMasterRequest(
    quest: IChatHistoryItemDocument,
    llm: ICompletionBackend,
    model: string,
    params: ChatCompletionCreateInput,
    sessionId: string,
    message: string,
    conversationHistory: IMessage[] = []
  ) {
    try {
      this.logger.log('QuestMaster Request Debug - Initial params:', {
        model,
        paramsReceived: params,
        sessionId,
        message: message.substring(0, 100) + '...',
        historyMessageCount: conversationHistory.length,
      });

      const questMaster = new QuestMaster(
        llm,
        {
          quests: this.chatCompletion.db.quests,
          questMasterPlans: this.chatCompletion.db.questMasterPlans,
        },
        async (quest, status) => {
          await this.chatCompletion.sendStatusUpdate(quest, status);
        },
        quest,
        this.logger,
        this.user.id
      );

      // History provides context about what the user has already discussed
      const questPlanResult = await questMaster.createQuestPlan(model, message, {
        history: conversationHistory,
      });

      // Return type is `string | void`:
      // - GPT-5 models with tool support use function calling, which handles processing internally
      //   and returns void (the quest plan is already saved to DB by processQuestPlan inside createQuestPlan)
      // - Other models return the HTML string that needs to be processed here
      if (typeof questPlanResult === 'string') {
        await questMaster.processQuestPlan(questPlanResult);
      }
      // If questPlanResult is void (undefined), GPT-5 function calling path already processed it

      if (this.user?.tags?.includes('debugQuestMaster')) {
        const debugText = typeof questPlanResult === 'string' ? questPlanResult : '[Processed via function calling]';
        await postMessageToSlack(
          this.chatCompletion.slackWebhookUrl,
          `*${this.user.name}* prompted: ${message}\nQuestMaster Plan:\n${debugText}`
        );
      }
    } catch (error) {
      this.logger.error('Error in QuestMaster processing:', error);
      throw error;
    }
  }

  /** Send an immediate rapid reply for QuestMaster activation, before the plan is generated. */
  private async sendQuestMasterRapidReply(quest: IChatHistoryItemDocument, message: string): Promise<void> {
    try {
      const rapidReplyContent = this.generateQuestMasterRapidReply(message);

      // Sent as a status message, not a stored reply
      await this.chatCompletion.sendStatusUpdate(quest, `🚀 ${rapidReplyContent}`, {
        immediate: true,
        statusAt: new Date(),
      });

      this.logger.info(`🚀 [QuestMaster] Rapid reply sent: "${rapidReplyContent.substring(0, 100)}..."`);
    } catch (error) {
      // Don't throw - rapid reply failures shouldn't break QuestMaster
      this.logger.warn('Failed to send QuestMaster rapid reply:', error);
    }
  }

  /** Generate an enthusiastic rapid reply message for QuestMaster activation. */
  private generateQuestMasterRapidReply(message: string): string {
    const lowerMessage = message.toLowerCase();

    // Determine the type of quest based on keywords
    let questType = 'comprehensive plan';
    if (lowerMessage.includes('learn') || lowerMessage.includes('study') || lowerMessage.includes('understand')) {
      questType = 'learning journey';
    } else if (lowerMessage.includes('build') || lowerMessage.includes('create') || lowerMessage.includes('make')) {
      questType = 'step-by-step build guide';
    } else if (
      lowerMessage.includes('improve') ||
      lowerMessage.includes('optimize') ||
      lowerMessage.includes('better')
    ) {
      questType = 'improvement roadmap';
    } else if (lowerMessage.includes('solve') || lowerMessage.includes('fix') || lowerMessage.includes('debug')) {
      questType = 'solution strategy';
    } else if (
      lowerMessage.includes('plan') ||
      lowerMessage.includes('strategy') ||
      lowerMessage.includes('approach')
    ) {
      questType = 'strategic plan';
    }

    const responses = [
      `Great idea! 🎯 I'm creating a detailed ${questType} to help you achieve exactly what you're looking for. This Quest will break everything down into clear, actionable steps that you can follow at your own pace!`,

      `Perfect! ✨ Let me craft a comprehensive ${questType} that will guide you through this step-by-step. I'm organizing all the key tasks and sub-tasks to make this as smooth as possible for you!`,

      `Excellent request! 🚀 I'm building a structured ${questType} that will transform your goal into a clear roadmap. Each task will have specific actions you can take to move forward!`,

      `Love this! 💫 Creating a detailed ${questType} right now that will break down everything you need to know and do. This Quest will be your personal guide to success!`,

      `Fantastic! 🌟 I'm putting together a thorough ${questType} that will give you clarity and direction. Each step will build on the last to help you reach your objective efficiently!`,
    ];

    return responses[Math.floor(Math.random() * responses.length)];
  }
}

export class ProjectFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private logger: Logger;
  private project: IProjectDocument;

  constructor(chatCompletion: ChatCompletionContext, project: IProjectDocument) {
    this.chatCompletion = chatCompletion;
    this.logger = chatCompletion.logger;
    this.project = project;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(
    quest: IChatHistoryItemDocument,
    embeddingFactory: EmbeddingFactory,
    message: string,
    max_tokens: number,
    modelInfo: ModelInfo
  ): Promise<IMessage[]> {
    if (!this.project) return [];

    const allSystemPromptFileIds = this.project.systemPrompts
      .filter(prompt => prompt.enabled)
      .map(prompt => prompt.fileId);

    // Add project notebooks and notebook's knowledge files to the context
    const sessions = await this.getProjectNotebooks(this.chatCompletion.sessionId);
    const notebookFileIds = sessions.map(session => session.knowledgeIds ?? []).flat();
    const notebookSummaryFileIds = await this.getProjectNotebookSummaries(sessions);

    // Add system prompt and project file IDs to the list of files to process
    const projectFileIds = uniq([
      ...allSystemPromptFileIds,
      ...this.project.fileIds,
      ...notebookFileIds,
      ...notebookSummaryFileIds,
    ]);
    const projectFabMessages = await this.chatCompletion.fabFilesToMessages(
      projectFileIds,
      quest,
      embeddingFactory,
      message,
      max_tokens,
      modelInfo
    );

    return projectFabMessages.promptMessages;
  }

  async onComplete({ quest }: { quest: IChatHistoryItemDocument }): Promise<void> {
    if (this.chatCompletion.user.tags && this.chatCompletion.user.tags.includes('debugProjectNotebookFeature')) {
      const questReplies = (quest.replies || [])[0];
      const opening = questReplies.substring(0, 400);
      const closing = questReplies.substring(questReplies.length - 400, questReplies.length);
      await postMessageToSlack(
        this.chatCompletion.slackWebhookUrl,
        `*${this.chatCompletion.user.name}* prompted: ${quest.prompt} QuestMaster Plan*:\n${opening}...\n...\n...${closing}`
      );
    }
  }

  private async getProjectNotebooks(sessionId: string): Promise<ISessionDocument[]> {
    const sessions = await this.chatCompletion.db.sessions.findAllByIds(
      this.project.sessionIds.filter(id => id !== sessionId)
    );
    return sessions;
  }

  private async getProjectNotebookSummaries(sessions: ISessionDocument[]): Promise<string[]> {
    Logger.globalInstance.log(`Adding project notebooks to context: found ${sessions.length} notebooks`);
    const fabFiles = await this.chatCompletion.db.fabfiles.find({ sessionId: { $in: sessions.map(s => s.id) } });
    return fabFiles.map(f => f.id);
  }
}

export const SUMMARIZATION_CONFIG = {
  earlyMilestoneQuestCount: 3, // Summarize after 3rd quest (aligns with auto-naming)
  contentGrowthThreshold: 10, // Summarize after every 10 additional quests
  minTimeBetweenSummaries: 30, // Minimum minutes between auto-summarizations
} as const;

export interface SummarizationCheckContext {
  db: { quests: { count: (filter: Record<string, unknown>) => Promise<number> } };
  logger: Logger;
}

/**
 * Decide whether a session is due for re-summarization. Shared by the chat path
 * (`SummarizeNotebookFeature`) and the image-gen path so that image-only sessions
 * also accumulate long-term context. The actual summarization is published as an
 * EventBridge event by the caller.
 *
 * Runs exactly one indexed quest-count query per call (or zero when throttled).
 * Pre-first-summary sessions can only hit `earlyMilestone`; post-summary sessions
 * can only hit `contentGrowth` - so each branch fetches only the count it needs.
 * Both queries use `(sessionId, timestamp)` which is covered by the
 * `sessionId_timestamp_desc` index on QuestModel.
 */
export async function shouldSummarizeSession(
  session: ISessionDocument,
  ctx: SummarizationCheckContext
): Promise<[boolean, ISessionDocument['summaryTrigger']]> {
  if (session.summaryAt) {
    const minutesSinceLastSummary = (Date.now() - session.summaryAt.getTime()) / (1000 * 60);
    if (minutesSinceLastSummary < SUMMARIZATION_CONFIG.minTimeBetweenSummaries) {
      ctx.logger.debug(`Throttling: Only ${minutesSinceLastSummary.toFixed(1)} minutes since last summary`);
      return [false, 'throttling'];
    }

    const questsSinceLastSummary = await ctx.db.quests.count({
      sessionId: session.id,
      timestamp: { $gt: session.summaryAt },
    });

    if (questsSinceLastSummary >= SUMMARIZATION_CONFIG.contentGrowthThreshold) {
      ctx.logger.debug(`Content growth threshold met: ${questsSinceLastSummary} new quests since last summary`);
      return [true, 'contentGrowth'];
    }

    return [false, undefined];
  }

  const totalQuestCount = await ctx.db.quests.count({ sessionId: session.id });

  if (totalQuestCount >= SUMMARIZATION_CONFIG.earlyMilestoneQuestCount) {
    ctx.logger.debug(`Early milestone reached: ${totalQuestCount} quests total`);
    return [true, 'earlyMilestone'];
  }

  return [false, undefined];
}

export class SummarizeNotebookFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private logger: Logger;

  constructor(chatCompletion: ChatCompletionContext) {
    this.chatCompletion = chatCompletion;
    this.logger = chatCompletion.logger;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(): Promise<IMessage[]> {
    return [];
  }

  async onComplete({ quest, session }: { quest: IChatHistoryItemDocument; session: ISessionDocument }): Promise<void> {
    const [shouldSummarize, trigger] = await shouldSummarizeSession(session, {
      db: this.chatCompletion.db,
      logger: this.logger,
    });

    if (shouldSummarize) {
      this.logger.info(`Triggering notebook summarization job for session ${quest.sessionId}`);
      this.chatCompletion.summarizeSession(quest.sessionId, trigger);
    } else {
      this.logger.debug(`Skipping summarization for session ${quest.sessionId} - criteria not met`);
    }
  }
}

/**
 * Feature that injects organization-level system prompts into the conversation context.
 * This allows enterprise customers like Lift Port to set domain-specific context that
 * overrides model training biases (e.g., focusing on lunar space elevators rather than
 * Earth-based space elevators).
 *
 * Layering, most specific first: user personal prompt > team/org prompt (this
 * feature) > B4M global prompt (base, all users).
 */
export class OrganizationPromptFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private logger: Logger;
  private organization: IOrganizationDocument | null;

  constructor(chatCompletion: ChatCompletionContext, organization: IOrganizationDocument | null) {
    this.chatCompletion = chatCompletion;
    this.logger = chatCompletion.logger;
    this.organization = organization;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(): Promise<IMessage[]> {
    if (!this.organization || !this.organization.systemPrompt) {
      return [];
    }

    const systemPrompt = this.organization.systemPrompt.trim();
    if (!systemPrompt) {
      return [];
    }

    this.logger.log(
      `📋 Adding organization system prompt for "${this.organization.name}" (${systemPrompt.length} chars)`
    );

    return [
      {
        role: 'system' as const,
        content: `[Organization Context - ${this.organization.name}]\n${systemPrompt}`,
      },
    ];
  }

  async onComplete(): Promise<void> {
    // No cleanup needed
  }
}

/**
 * SessionPromptFeature - injects a session-level system prompt verbatim.
 *
 * Generic capability: any session that carries `systemPromptText` gets it as a
 * system message, layered alongside org/project prompts. This lets a product
 * surface (e.g. LibreOncology) scope a session's behavior without a project
 * record - set the prompt at session creation and it applies unconditionally.
 * Keyed purely on the session field; no product-specific branching here.
 */
export class SessionPromptFeature implements ChatCompletionFeature {
  private logger: Logger;
  private systemPromptText: string | undefined;

  constructor(chatCompletion: ChatCompletionContext, systemPromptText: string | undefined) {
    this.logger = chatCompletion.logger;
    this.systemPromptText = systemPromptText;
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(): Promise<IMessage[]> {
    const systemPrompt = this.systemPromptText?.trim();
    if (!systemPrompt) {
      return [];
    }

    this.logger.log(`📋 Adding session system prompt (${systemPrompt.length} chars)`);

    return [
      {
        role: 'system' as const,
        content: systemPrompt,
      },
    ];
  }

  async onComplete(): Promise<void> {
    // No cleanup needed
  }
}

/** Forced-retrieval tuning. */
// Upper bound on lake files whose chunks we score (the whole lake for v1-scale lakes).
const FORCED_RETRIEVAL_MAX_CANDIDATE_FILES = 100;
// Total characters of retrieved chunk text injected into the prompt.
const FORCED_RETRIEVAL_CHAR_BUDGET = 12000;
// Minimum cosine similarity (ada-002) for a chunk to count as relevant. Below this,
// nothing is injected so the model refuses rather than grounding in off-topic content.
const FORCED_RETRIEVAL_MIN_SIMILARITY = 0.75;

/**
 * KnowledgeRetrievalFeature - forced server-side retrieval ("citation enforcer").
 *
 * Generic capability: when a session sets `forceKnowledgeRetrieval`, every user
 * turn triggers a retrieval against the user's tag-scoped data lakes BEFORE the
 * model answers, and the retrieved content is injected as a system message with
 * citations emitted to the UI. This guarantees grounded, cited answers regardless
 * of whether the model chooses to call the knowledge tools - the compliance-grade
 * path for reference products (e.g. LibreOncology). Reuses the same search +
 * chunk-read + citable logic as the knowledge tools. Keyed purely on the session
 * flag; no product-specific branching here. When the session sets
 * `citationStyle: 'indexed'`, each distinct source document is numbered in the
 * injected context and the model is instructed to cite by `[N]` only - the
 * emitted citables order is the index order, so clients resolve `[N]` to
 * `citables[N-1]` (index-only citation: the model never names a source, so it
 * cannot fabricate one).
 */
export class KnowledgeRetrievalFeature implements ChatCompletionFeature {
  private chatCompletion: ChatCompletionContext;
  private logger: Logger;
  /** Optional tag allowlist to scope retrieval to a subset of the accessible lake. */
  private retrievalTags: string[];
  /** How the injected context instructs citation: readable name (default) or [N] index. */
  private citationStyle: 'named' | 'indexed';
  /** Generic retrieval exclusion applied to the candidate file listing (see RetrievalExclusionOptions). */
  private retrievalFilter: RetrievalExclusionOptions;

  constructor(
    chatCompletion: ChatCompletionContext,
    retrievalTags?: string[],
    citationStyle?: 'named' | 'indexed',
    retrievalFilter?: RetrievalExclusionOptions
  ) {
    this.chatCompletion = chatCompletion;
    this.logger = chatCompletion.logger;
    this.retrievalTags = Array.isArray(retrievalTags) ? retrievalTags : [];
    this.citationStyle = citationStyle === 'indexed' ? 'indexed' : 'named';
    this.retrievalFilter = retrievalFilter ?? {};
  }

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  /**
   * Resolve the user's accessible data-lake tags/prefixes. Delegates to the single shared
   * resolver (getDynamicDataLakeAccess) so forced retrieval and the knowledge tools apply
   * the IDENTICAL entitlement-aware access rule - no drift between two copies. Entitlement
   * keys are resolved once on the process and passed through.
   */
  private async resolveDataLakeAccess(): Promise<{
    dataLakeTags: string[];
    dataLakeTagPrefixes: string[];
    scopedTagPrefixes: string[];
  }> {
    const { db, user } = this.chatCompletion;
    const entitlementKeys = await this.chatCompletion.resolveEntitlementKeys();
    return getDynamicDataLakeAccess({ db, user, entitlementKeys });
  }

  async getContextMessages(
    quest: IChatHistoryItemDocument,
    embeddingFactory: EmbeddingFactory,
    message: string
  ): Promise<IMessage[]> {
    const query = message?.trim();
    if (!query) return [];

    // Skip when the turn carries attached files - the question is about the
    // attachment (e.g. "read this figure"), not the curated library. Forcing lake
    // retrieval here injects off-topic context and emits spurious citations for
    // sources the answer never used. The model can still call search_knowledge_base
    // itself if it genuinely needs the library alongside the attachment.
    if (quest.fabFileIds && quest.fabFileIds.length > 0) {
      this.logger.log('🔒 Forced retrieval: skipped (turn has attached files)');
      return [];
    }

    const { db, user } = this.chatCompletion;
    if (!db.fabfiles || !db.fabfilechunks) {
      this.logger.warn('🔒 Forced retrieval: fabfiles/fabfilechunks repository unavailable — skipping');
      return [];
    }

    try {
      const { dataLakeTags, dataLakeTagPrefixes, scopedTagPrefixes } = await this.resolveDataLakeAccess();

      // 1. List the lake-accessible files (empty query -> all accessible). We rank by
      //    semantic similarity below, so this list's order doesn't matter.
      const fileResults = await db.fabfiles.search(
        user.id,
        '',
        { tags: this.retrievalTags, shared: false },
        { page: 1, limit: FORCED_RETRIEVAL_MAX_CANDIDATE_FILES },
        { by: 'fileName', direction: 'asc' },
        {
          textSearch: true,
          includeShared: true,
          userGroups: user.groups || [],
          dataLakeTags,
          dataLakeTagPrefixes, // static-registry (open) prefixes
          scopedTagPrefixes, // dynamic-lake prefixes — owner/org-scoped
          excludeContent: true, // metadata only; chunk text + vectors fetched below
          // Retrieval exclusion (opt-in): keep excluded/unvectorized files out of forced grounding
          // so this arm agrees with the surface's document-listing predicate. No-op when unset.
          ...this.retrievalFilter,
        }
      );

      // Authoritative post-filter: the DB clause above is a best-effort pre-filter; re-apply the
      // exclusion in memory so correctness never depends on the DB regex engine or fileNameLower.
      const files = filterRetrievalExcluded(fileResults.data, this.retrievalFilter);
      if (files.length === 0) {
        this.logger.log('🔒 Forced retrieval: no accessible data-lake files');
        return [];
      }
      const fileById = new Map(files.map(f => [f.id, f]));

      // 2. Embed the query with the lake's embedding model (must match the chunks').
      const embeddingModel = (files.find(f => f.embeddingModel)?.embeddingModel ||
        OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002) as SupportedEmbeddingModel;
      const embeddingService = embeddingFactory.createEmbeddingService(embeddingModel);
      const queryVector = await embeddingService.generateEmbedding(query);

      // 3. Score every chunk across candidate files by cosine similarity to the query.
      const chunkLists = await Promise.all(files.map(f => db.fabfilechunks!.findByFabFileId(f.id)));
      const scored: { chunk: IFabFileChunkDocument; score: number }[] = [];
      for (const chunks of chunkLists) {
        for (const chunk of chunks) {
          if (!chunk.vector || chunk.vector.length === 0) continue;
          scored.push({ chunk, score: computeCosineSimilarity(queryVector, chunk.vector) });
        }
      }
      if (scored.length === 0) {
        this.logger.log('🔒 Forced retrieval: candidate files have no vectorized chunks');
        return [];
      }
      scored.sort((a, b) => b.score - a.score);

      // 4. Inject the most-similar chunks (above the relevance floor) up to the budget.
      //    If nothing clears the floor, inject nothing so the model refuses rather than
      //    grounding in off-topic content.
      let used = 0;
      const sections: string[] = [];
      const sourceFileIds: string[] = [];
      for (const { chunk, score } of scored) {
        if (score < FORCED_RETRIEVAL_MIN_SIMILARITY) break; // sorted desc — the rest are lower
        if (used >= FORCED_RETRIEVAL_CHAR_BUDGET) break;
        const file = fileById.get(chunk.fabFileId);
        const remaining = FORCED_RETRIEVAL_CHAR_BUDGET - used;
        const text = chunk.text.length > remaining ? chunk.text.slice(0, remaining) : chunk.text;
        const name = file?.fileName || chunk.fabFileId;
        // Distinct-file first-appearance order IS the citation index order: the
        // citables emitted below follow sourceFileIds, so [N] -> citables[N-1].
        let fileIdx = sourceFileIds.indexOf(chunk.fabFileId);
        if (fileIdx === -1) {
          sourceFileIds.push(chunk.fabFileId);
          fileIdx = sourceFileIds.length - 1;
        }
        const heading =
          this.citationStyle === 'indexed'
            ? `### [${fileIdx + 1}] ${name} (ID: ${chunk.fabFileId})`
            : `### ${name} (ID: ${chunk.fabFileId})`;
        sections.push(`${heading}\n${text}`);
        used += text.length;
      }

      if (sections.length === 0) {
        this.logger.log(
          `🔒 Forced retrieval: no chunk cleared the similarity floor (top=${scored[0].score.toFixed(3)})`
        );
        return [];
      }

      // Emit citation chips for the distinct source files so the UI shows "Sources (N)".
      const citables: CitableSource[] = sourceFileIds.map((fid, index) => {
        const file = fileById.get(fid);
        const tagDesc = (file?.tags?.map(t => t.name) || [])
          .filter(t => !t.startsWith('datalake:'))
          .slice(0, 4)
          .join(', ');
        return {
          id: fid,
          type: 'document' as const,
          title: file?.fileName || fid,
          url: `/opti?mode=datalake&article=${fid}`,
          description: tagDesc || undefined,
          timestamp: new Date().toISOString(),
          status: 'complete' as const,
          metadata: {
            sourceSystem: 'knowledge_base',
            tags: file?.tags?.map(t => t.name) || [],
            relevanceScore: 1 - index * 0.1,
          },
        };
      });
      quest.promptMeta = quest.promptMeta || {};
      const existingCitables = quest.promptMeta.citables || [];
      const citableKey = (c: CitableSource) => c.id || c.url || c.title;
      if (this.citationStyle === 'indexed') {
        // INVARIANT (indexed style): the [N] headings above number sources 1..k in
        // `citables` order, so the emitted manifest MUST keep these forced-retrieval
        // citables as its contiguous, index-aligned PREFIX ([N] -> citables[N-1] on the
        // client). getContextMessages runs once per quest before any tool call, so
        // existingCitables is normally empty - but enforce the prefix defensively rather
        // than trusting that: emit the numbered citables first, then any non-colliding
        // pre-existing ones. A mismatch here would be an in-range -> wrong-document
        // misattribution the client's out-of-range check cannot detect.
        if (existingCitables.length > 0) {
          this.logger.warn(
            `🔒 Forced retrieval (indexed): ${existingCitables.length} citable(s) already present before ` +
              'numbered injection — keeping forced-retrieval citables as the index-aligned prefix.'
          );
        }
        const newKeys = new Set(citables.map(citableKey).filter(Boolean));
        const keptExisting = existingCitables.filter(c => {
          const key = citableKey(c);
          return !key || !newKeys.has(key);
        });
        quest.promptMeta.citables = [...citables, ...keptExisting];
      } else {
        // Named style: legacy order - existing citables first, then de-duplicated new ones.
        const seenKeys = new Set(existingCitables.map(citableKey).filter(Boolean));
        const newCitables = citables.filter(c => {
          const key = citableKey(c);
          if (!key || seenKeys.has(key)) return false;
          seenKeys.add(key);
          return true;
        });
        quest.promptMeta.citables = [...existingCitables, ...newCitables];
      }
      await this.chatCompletion.sendStatusUpdate(quest, 'Grounded in the knowledge base');

      this.logger.log(
        `🔒 Forced retrieval: injected ${sections.length} chunk(s) from ${sourceFileIds.length} document(s), ` +
          `${used} chars, top similarity ${scored[0].score.toFixed(3)}`
      );

      const header =
        this.citationStyle === 'indexed'
          ? '[Knowledge Base — Retrieved Context]\n' +
            `The following content was retrieved from the curated library for this query, drawn from ${sourceFileIds.length} ` +
            'numbered source document(s) — each section heading carries its document number as [N]. Ground your answer in this ' +
            'content and cite ONLY by bracketed index (e.g. [1], [3]) placed immediately after the claim it supports. Never write ' +
            `source names or URLs as citations, never invent references, and never cite an index above ${sourceFileIds.length}. ` +
            'If the retrieved content does not address the question, say so rather than relying on outside knowledge.\n\n'
          : '[Knowledge Base — Retrieved Context]\n' +
            'The following content was retrieved from the curated library for this query. Ground your answer in it and ' +
            'cite documents by name. If it does not address the question, say so rather than relying on outside knowledge.\n\n';
      return [{ role: 'system' as const, content: header + sections.join('\n\n---\n\n') }];
    } catch (error) {
      this.logger.error('🔒 Forced retrieval failed:', error);
      return [];
    }
  }

  async onComplete(): Promise<void> {
    // No cleanup needed
  }
}

const CONTEXT_SUMMARIZATION_RATE_LIMIT_MINUTES = 5;

export class ContextSummarizationFeature implements ChatCompletionFeature {
  constructor(private chatCompletion: ChatCompletionContext) {}

  async beforeDataGathering(): Promise<{ shouldContinue: boolean }> {
    return { shouldContinue: true };
  }

  async getContextMessages(): Promise<IMessage[]> {
    return [];
  }

  async onComplete({
    quest,
    session,
    historyCount,
    oldestIncludedQuestId,
  }: {
    quest: IChatHistoryItemDocument;
    session: ISessionDocument;
    messages: IMessage[];
    questMaster: z.infer<typeof QuestMasterParamsSchema> | undefined;
    model: string;
    historyCount?: number;
    oldestIncludedQuestId?: string | null;
  }): Promise<void> {
    // Only trigger when there's confirmed overflow AND we have a boundary
    if (!historyCount || !oldestIncludedQuestId) return;
    if (!session.messageCount || session.messageCount <= historyCount) return;

    // Rate-limit: skip if summarized recently
    if (session.contextSummaryAt) {
      const minutesSince = (Date.now() - session.contextSummaryAt.getTime()) / 60_000;
      if (minutesSince < CONTEXT_SUMMARIZATION_RATE_LIMIT_MINUTES) return;
    }

    await this.chatCompletion.contextSummarizeSession(quest.sessionId, oldestIncludedQuestId);
  }
}
