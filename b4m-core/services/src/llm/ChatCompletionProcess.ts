import {
  IChatHistoryItemDocument,
  IMessage,
  IUserDocument,
  LLMEvents,
  IOrganizationDocument,
  Permission,
  SettingKey,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
  QueryComplexityType,
  getTextModelCost,
  CACHE_READ_MULTIPLIER,
  ModelInfo,
  ModelBackend,
  b4mLLMTools,
  getCurrentPathFromContext,
  getViewSummaryForLLM,
  isNavigableFeaturePath,
  ReasoningEffort,
  ICacheStrategy,
  generateAnonymousSessionId,
  CreditHolderType,
  ICreditHolder,
  ICreditHolderMethods,
  isImageServeable,
  QuestErrorCode,
  getQuestErrorCode,
} from '@bike4mind/common';
import {
  BadRequestError,
  buildAndSortMessages,
  calculateTotalTokenLength,
  ClientMessageSender,
  EmbeddingFactory,
  fetchAndConvertFabFiles,
  fetchAndProcessPreviousMessages,
  getLlmWithFallback,
  getSettingByName,
  getSettingsMap,
  getSettingsValue,
  NotFoundError,
  ForbiddenError,
  TooManyRequestsError,
  OpenaiModerationsService,
  FlaggedContentError,
  processFabFilesServer,
  processUrlsFromPrompt,
  isOverloadedError,
  shouldTriggerFallback,
  stripAllToolBlocks,
  usdToCredits,
  usdToCreditsStochastic,
  LOW_CREDIT_ALERT_THRESHOLD,
  ITokenizer,
  getLastBuildDebugInfo,
  getSettingsByNames,
} from '@bike4mind/utils';
import {
  getAvailableModels,
  getLlmByModel,
  type ICompletionOptions,
  PipelineTimer,
  resolveDeprecatedModelId,
} from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { ToolCacheManager } from './tools/ToolCacheManager';
import { ToolValidator } from './tools/ToolValidator';
import { ToolBuilder } from './tools/ToolBuilder';
import { LATTICE_TOOL_NAMES } from './tools';
import type { SubagentTelemetryData } from './tools/implementation/delegateToAgent';
import { createHmac } from 'crypto';
import { MongoAbility } from '@casl/ability';
import { Mutex } from 'async-mutex';
import { z } from 'zod';
import { getEffectiveLLMApiKeys } from '../apiKeyService';
import { applyModerationHit, MODERATION_POLICY, moderationThrottleKey } from '../userService/moderationPolicy';
import { ToolDefinition } from './tools/base/types';
import { ServerAgentStore } from './agents/ServerAgentStore';
import throttle from 'lodash/throttle.js';
import {
  AutoNameSessionFeature,
  ChatCompletionFeature,
  ContextSummarizationFeature,
  MementoFeature,
  OrganizationPromptFeature,
  SessionPromptFeature,
  KnowledgeRetrievalFeature,
  ProjectFeature,
  QuestMasterFeature,
  SlackFeature,
  SummarizeNotebookFeature,
  IChatCompletionServiceOptions,
  QuestStartBodySchema,
  featureNames,
} from './ChatCompletionFeatures';
import { AgentDetectionFeature } from './features/AgentDetectionFeature';
import { SkillsFeature } from './features/SkillsFeature';
import { StatusManager } from './StatusManager';
import { buildContextOverflowMessage } from './contextOverflowMessage';
import { buildInsufficientCreditsMessage } from './insufficientCreditsMessage';
import { ResearchModeService } from './ResearchModeService';
import { deductCreditsWithOrgSupport, subtractCredits } from '../creditService';
import {
  TelemetryBuilder,
  mapBackendToProvider,
  categorizeToolError,
  AnomalyAlertService,
  aggregateWebFetchContentTelemetry,
} from '../telemetry';
import type { ToolTelemetry, ToolErrorCategory } from '@bike4mind/common';
import {
  ContextTelemetryAlertsSchema,
  detectAgentMentions,
  sanitizeTelemetryError,
  mapMimeTypeToArtifactType,
  ARTIFACT_EMISSION_PROMPT,
  HELP_CENTER_PROMPT,
} from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/llm-adapters';

const THROTTLE_INTERVAL = 100;
const DISABLE_SERVER_THROTTLING = process.env.DISABLE_SERVER_THROTTLING === 'true';
const STREAMING_HEARTBEAT_INTERVAL_MS = 10_000;
const STREAMING_HEARTBEAT_ERROR_ESCALATION_THRESHOLD = 3;

// Context management constants: message-history limits per query type

/**
 * Fallback value when model context window is unknown.
 * Conservative default for safety.
 */
const DEFAULT_HISTORY_COUNT = 30;

/**
 * Minimum history count regardless of model size.
 */
const MIN_HISTORY_COUNT = 10;

/**
 * Maximum history count. Even with large context windows, very long
 * histories hit diminishing returns and add latency.
 */
const MAX_HISTORY_COUNT = 150;

/**
 * Estimated average tokens per message (user + assistant pair), used for
 * dynamic history calculation. Conservative estimate.
 */
const ESTIMATED_TOKENS_PER_MESSAGE = 750;

/**
 * Reserved tokens for system prompt and instructions.
 */
const SYSTEM_PROMPT_RESERVE = 4000;

/**
 * Reserved tokens for model response.
 */
const RESPONSE_RESERVE = 8000;

/**
 * Percentage of context budget allocated to history (vs knowledge files).
 * The buildAndSortMessages function allocates 30% to history, 70% to files.
 */
const HISTORY_BUDGET_PERCENTAGE = 0.3;

/**
 * Conservative fallback for simple query max history.
 * Used before model info is available.
 */
const SIMPLE_QUERY_FALLBACK_MAX = 25;

/**
 * Conservative fallback for complex query max history.
 * Used before model info is available.
 */
const COMPLEX_QUERY_FALLBACK_MAX = 60;

/**
 * Calculate optimal history count based on model context window.
 *
 * Formula:
 *   availableForHistory = contextWindow * 0.3 (30% for history)
 *   historyTokenBudget = availableForHistory - systemReserve - responseReserve
 *   optimalCount = historyTokenBudget / avgTokensPerMessage
 *
 * @param contextWindow - Model's context window size in tokens
 * @returns Optimal number of history messages to include
 */
function calculateOptimalHistoryCount(contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) {
    return DEFAULT_HISTORY_COUNT;
  }

  const availableForHistory = contextWindow * HISTORY_BUDGET_PERCENTAGE;
  const historyTokenBudget = availableForHistory - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE;

  if (historyTokenBudget <= 0) {
    return MIN_HISTORY_COUNT;
  }

  const optimalCount = Math.floor(historyTokenBudget / ESTIMATED_TOKENS_PER_MESSAGE);

  // Clamp to reasonable bounds
  return Math.max(MIN_HISTORY_COUNT, Math.min(MAX_HISTORY_COUNT, optimalCount));
}

/**
 * Get maximum history for simple queries.
 * Simple queries need less context but should still scale with model capacity.
 *
 * @param contextWindow - Model's context window size in tokens
 * @returns Maximum history messages for simple queries
 */
function getSimpleQueryMaxHistory(contextWindow: number): number {
  // Simple queries get 40% of the optimal history count
  const optimal = calculateOptimalHistoryCount(contextWindow);
  return Math.max(MIN_HISTORY_COUNT, Math.floor(optimal * 0.4));
}

/**
 * Get maximum history for complex queries.
 * Complex queries benefit from more context.
 *
 * @param contextWindow - Model's context window size in tokens
 * @returns Maximum history messages for complex queries
 */
function getComplexQueryMaxHistory(contextWindow: number): number {
  // Complex queries get the full optimal history count
  return calculateOptimalHistoryCount(contextWindow);
}

/**
 * Session length threshold for recommending a new session. Sessions past
 * ~100 message pairs cost more per query, lose context relevance (older
 * messages less useful), and add latency; suggest a new session or summary.
 */
const SESSION_LENGTH_WARNING_THRESHOLD = 100;

const questSaveMutex = new Mutex();

interface ProcessInitContext {
  parsedBody: z.infer<typeof QuestStartBodySchema>;
  quest: IChatHistoryItemDocument;
  historyCount: number;
  enableQuestMaster?: boolean;
  enableMementos?: boolean;
  enableAgents?: boolean;
  message: string;
  messageFileIds: string[];
  sessionFabFileIds: string[];
  params: z.infer<typeof QuestStartBodySchema>['params'];
  enabledTools: (z.infer<typeof b4mLLMTools> | string)[];
  hasContentTransform?: boolean;
  projectId?: string;
  organizationId?: string | null;
  questMaster?: z.infer<typeof QuestStartBodySchema>['questMaster'];
  toolPromptId?: string;
  researchMode?: z.infer<typeof QuestStartBodySchema>['researchMode'];
  embeddingModel?: string;
  queryComplexity: string;
  imageConfig?: z.infer<typeof QuestStartBodySchema>['imageConfig'];
  deepResearchConfig?: z.infer<typeof QuestStartBodySchema>['deepResearchConfig'];
  userTimezone?: string;
}

export class InsufficientCreditsError extends Error {
  /**
   * Optional machine-readable classifier propagated onto the error quest
   * (`quest.errorCode`) so the client can render a targeted error state. Set only
   * for genuine out-of-credits throws - the dispute-pending fraud gates reuse this
   * error class but must NOT surface an "Add Credits" CTA, so they leave it unset.
   */
  readonly code?: QuestErrorCode;
  constructor(message: string, code?: QuestErrorCode) {
    super(message);
    this.name = 'InsufficientCreditsError';
    this.code = code;
  }
}

/**
 * Prompt marker that, on preview/E2E deploys only (never production), forces the primary
 * model to simulate a sustained outage so the provider/model fallback path can be exercised
 * end-to-end by QA. See the gated check in the completion loop and the Guide for Testers.
 */
export const FORCE_FALLBACK_TEST_MARKER = '[[force-provider-fallback]]';

function isToolPairingError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  // Match known Anthropic tool-pairing failure patterns:
  // - messages mentioning both "tool_use" and "tool_result"
  // - messages mentioning "tool_use_id" (e.g., "unexpected tool_use_id")
  const hasToolUseAndResult = msg.includes('tool_use') && msg.includes('tool_result');
  const hasToolUseIdVariant = msg.includes('tool_use_id');
  return hasToolUseAndResult || hasToolUseIdVariant;
}

export function isRequestTimeoutError(error: Error): boolean {
  return error.message.includes('request timeout') || error.message.includes('Request timeout');
}

/**
 * True when an error is a request abort/cancellation (user stop, client
 * disconnect, or request/idle timeout) rather than a real failure. Aborts are
 * benign and recoverable, so they must NOT be logged at error severity: the
 * CloudWatch ERROR to LiveOps/Slack alert path pages on routine cancellations.
 * Mirrors the inline check used in the quest-level error handler below and the
 * `isAbortError` helper in ReActAgent. Case-insensitive `aborted` catches the
 * bare `new Error('Aborted')` from retry helpers as well as SDK phrasings like
 * 'Request aborted' / 'operation was aborted'.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return error.message.toLowerCase().includes('aborted');
}

export function isStreamIdleTimeoutError(error: Error): boolean {
  return error.message.includes('stream timeout') || error.message.includes('Stream timeout');
}

/**
 * Decide whether to auto-attach the `navigate_view` tool based on the user's
 * current path (extracted from the `[Current View Context]` system message).
 *
 * On the main chat page (`/`) or when no view context is available, the tool
 * is pure overhead - it adds a tool-call round trip and a misleading
 * "Navigate View" status to general Q&A turns that have nothing to navigate
 * to. Delegated to the registry-derived helpers so the allow-list never
 * drifts from the registered views.
 */
export function shouldAutoEnableNavigateView(
  extraContextMessages: z.infer<typeof QuestStartBodySchema>['extraContextMessages']
): boolean {
  return isNavigableFeaturePath(getCurrentPathFromContext(extraContextMessages));
}

/**
 * If `trigger` is enabled and `paired` is not, append `paired`. Returns a new array; does not
 * mutate the input. Used for tool dependencies where one tool is useless without its companion
 * (e.g. `search_knowledge_base` returns metadata only - the LLM needs `retrieve_knowledge_content`
 * to actually read the file text).
 */
export function addPairedTool<T extends string>(tools: readonly T[], trigger: T, paired: T): T[] {
  if (tools.includes(trigger) && !tools.includes(paired)) {
    return [...tools, paired];
  }
  return [...tools];
}

/**
 * Tools this process auto-adds server-side regardless of user selection (see the
 * auto-add pushes in the request-parse method: blog_publish/blog_edit/blog_draft
 * for admins, navigate_view, skill). Small local (Ollama) models get confused by
 * tools they didn't ask for, so these are trimmed for that backend unless the user
 * explicitly enabled them. Keep this list in sync with those auto-add sites.
 */
export const AUTO_ADDED_TOOL_NAMES = ['blog_draft', 'blog_publish', 'blog_edit', 'navigate_view', 'skill'];

/**
 * Reconciliation delta with the zero-balance floor. Pre-reservation (the only
 * insufficient-funds check) runs on the local estimate, so a provider-basis
 * settlement (cache writes in particular) can exceed the reservation. When the
 * shortfall debit exceeds the holder's balance, the debit clamps to what the
 * holder has and the rest is reported as writtenOffCredits: uncollected revenue
 * the usage event must surface so margin reporting doesn't count a phantom
 * collection. Best effort: the balance snapshot predates concurrent spend.
 */
export function computeSettlementDelta(
  reservedCredits: number,
  totalCreditsUsed: number,
  availableCredits: number
): { delta: number; writtenOffCredits: number } {
  const delta = reservedCredits - totalCreditsUsed;
  if (delta >= 0) return { delta, writtenOffCredits: 0 };
  const available = Math.max(0, availableCredits);
  if (-delta <= available) return { delta, writtenOffCredits: 0 };
  // `available > 0 ? ...` avoids returning -0 when the balance is empty.
  return { delta: available > 0 ? -available : 0, writtenOffCredits: -delta - available };
}

export class ChatCompletionProcess {
  public db: IChatCompletionServiceOptions['db'];
  public invokeCreateMemento: IChatCompletionServiceOptions['invokeCreateMemento'];
  public logger: Logger;
  public user: IUserDocument;
  public logEvent: IChatCompletionServiceOptions['logEvent'];
  public queue: IChatCompletionServiceOptions['queue'];
  public autoNameSession: IChatCompletionServiceOptions['autoNameSession'];
  public summarizeSession: IChatCompletionServiceOptions['summarizeSession'];
  public contextSummarizeSession: IChatCompletionServiceOptions['contextSummarizeSession'];
  public slackWebhookUrl: string;
  public features: Map<featureNames, ChatCompletionFeature>;
  public userAbility: MongoAbility | null = null;
  public sessionId: string;
  /**
   * Caller's resolved entitlement keys, populated lazily/once by resolveEntitlementKeys()
   * from the injected getEntitlements. Read by retrieval to gate entitlement-scoped lakes.
   * NEVER set from cached static options - it is a per-request, per-user value.
   */
  public entitlementKeys: string[] = [];
  private getEntitlements: IChatCompletionServiceOptions['getEntitlements'];
  private entitlementsResolved = false;
  private storage: IChatCompletionServiceOptions['storage'];
  private imageGenerateStorage: IChatCompletionServiceOptions['imageGenerateStorage'];
  private imageProcessorLambdaName?: string;
  private wsHttpsUrl: string;
  private abilityGetter: IChatCompletionServiceOptions['abilityGetter'];
  private getScopeFilter: IChatCompletionServiceOptions['getScopeFilter'];
  private getMcpClient: IChatCompletionServiceOptions['getMcpClient'];
  private statusManager: StatusManager | null = null;
  private systemFilesCache: Map<string, [string[], string[]]> | null = null;
  private abortControllers: Map<string, AbortController> | null = null;
  private tokenizer: ITokenizer;
  private cacheRepository?: IChatCompletionServiceOptions['cacheRepository'];
  private publishTelemetryAlert?: IChatCompletionServiceOptions['publishTelemetryAlert'];
  private telemetryHmacSecret?: string;
  private gpcSignalDetected: boolean = false;
  private onReplyStream?: IChatCompletionServiceOptions['onReplyStream'];
  private onToolPreamble?: IChatCompletionServiceOptions['onToolPreamble'];
  private verbose: boolean = false;
  private toolCreditsMap: Map<string, number> = new Map();
  private subagentTelemetryData: SubagentTelemetryData[] = [];
  // Credit reservation tracking (pre-reserve/reconcile pattern)
  private reservedCredits: number = 0;
  private reservedCreditsOwnerId: string = '';
  private reservedCreditsOwnerType: CreditHolderType = CreditHolderType.User;
  private reservedCreditHolder: ICreditHolder | null = null;

  // Phase 2: Tool state management
  private toolCacheManager: ToolCacheManager;
  private toolValidator: ToolValidator;

  constructor(options: IChatCompletionServiceOptions) {
    this.db = options.db;
    this.invokeCreateMemento = options.invokeCreateMemento;
    this.storage = options.storage;
    this.imageGenerateStorage = options.imageGenerateStorage;
    this.imageProcessorLambdaName = options.imageProcessorLambdaName;
    this.logger = options.logger;
    this.user = options.user;
    this.logEvent = options.logEvent;
    this.queue = options.queue;
    this.autoNameSession = options.autoNameSession;
    this.summarizeSession = options.summarizeSession;
    this.contextSummarizeSession = options.contextSummarizeSession;
    this.wsHttpsUrl = options.wsHttpsUrl;
    this.abilityGetter = options.abilityGetter;
    this.getScopeFilter = options.getScopeFilter;
    this.getEntitlements = options.getEntitlements;
    this.getMcpClient = options.getMcpClient;
    this.features = options.features || new Map<featureNames, ChatCompletionFeature>();
    this.tokenizer = options.tokenizer;
    this.slackWebhookUrl = options.slackWebhookUrl;
    this.sessionId = options.sessionId;
    this.cacheRepository = options.cacheRepository;
    this.publishTelemetryAlert = options.publishTelemetryAlert;
    this.telemetryHmacSecret = options.telemetryHmacSecret;
    this.gpcSignalDetected = options.gpcSignalDetected ?? false;
    this.onReplyStream = options.onReplyStream;
    this.onToolPreamble = options.onToolPreamble;
    this.statusManager = null;
    this.userAbility = null;
    this.systemFilesCache = null;
    this.abortControllers = null;
    this.toolCacheManager = new ToolCacheManager(this.logger);
    this.toolValidator = new ToolValidator(this.logger, this.toolCacheManager);
  }

  /**
   * Resolve the caller's entitlement keys once per process via the injected getEntitlements,
   * memoizing the result (an empty list is a valid, memoizable result). Both the forced
   * retrieval feature and the tool path read these keys to gate entitlement-scoped lakes.
   * No injection => empty keys => tag-only matching (the neutral default).
   */
  public async resolveEntitlementKeys(): Promise<string[]> {
    if (!this.entitlementsResolved) {
      try {
        this.entitlementKeys = (await this.getEntitlements?.(this.user)) ?? [];
      } catch (err) {
        // Fail-safe: an entitlement-resolution failure (e.g. a subscription DB read error)
        // must NEVER break the chat turn. Degrade to tag-only matching - exactly the pre-Q3b
        // behavior. Entitlement-gated lakes (libonc) fail closed; tag-gated lakes (Opti)
        // and the entire main-app chat path are unaffected. This is what keeps wiring
        // getEntitlements into the shared chat defaults a non-regression for every surface.
        this.logger.warn(
          `Entitlement resolution failed; falling back to tag-only lake access: ${(err as Error)?.message}`
        );
        this.entitlementKeys = [];
      }
      this.entitlementsResolved = true;
    }
    return this.entitlementKeys;
  }

  private async initializeProcessContext(
    body: z.infer<typeof QuestStartBodySchema>,
    logger: Logger,
    processStartTime: number,
    prefetchedQuest?: IChatHistoryItemDocument
  ): Promise<ProcessInitContext> {
    const parsedBody = QuestStartBodySchema.parse(body);
    const { questId, sessionId } = parsedBody;

    // Use pre-fetched quest when available (wait=true path), otherwise fetch from DB
    const quest = prefetchedQuest ?? (await this.db.quests.findById(questId));
    if (!quest) {
      throw new NotFoundError('Quest not found');
    }
    logger.info(
      `⏱️ [${Date.now() - processStartTime}ms] Process started from quest creation ${Date.now() - quest.createdAt.getTime()}ms`
    );

    const clientInitStartTime = Date.now();
    if (!this.statusManager) {
      this.statusManager = new StatusManager(
        new ClientMessageSender(this.db, logger),
        logger,
        this.wsHttpsUrl,
        this.user.id
      );
      logger.info('StatusManager initialized');
    }
    logger.info(
      `⏱️ [${Date.now() - processStartTime}ms] StatusManager initialized in ${Date.now() - clientInitStartTime}ms`
    );

    this.sendStatusUpdate(quest, 'Processing your request...', {
      statusAt: new Date(),
      skipPayloadOptimization: true,
    });

    const {
      message,
      messageFileIds = [],
      fabFileIds: sessionFabFileIds,
      params,
      tools: enabledTools = [],
      projectId,
      organizationId,
      questMaster,
      toolPromptId,
      researchMode,
      embeddingModel,
      queryComplexity,
      imageConfig,
      deepResearchConfig,
      timezone: userTimezone,
    } = parsedBody;

    // Pair tools that are useless without their companion. The UI exposes single toggles
    // ("Image Generation", "Knowledge Base Search") that imply the paired capability.
    let finalEnabledTools: string[] = addPairedTool(enabledTools, 'image_generation', 'edit_image');
    finalEnabledTools = addPairedTool(finalEnabledTools, 'search_knowledge_base', 'retrieve_knowledge_content');
    let hasContentTransform = false;

    // Auto-add blog_publish tool if user has blog integration configured (admin-only for now)
    if (this.user.isAdmin && this.user.blogIntegration && !enabledTools.includes('blog_publish')) {
      finalEnabledTools.push('blog_publish');
    }

    // Auto-add blog_edit tool if user has blog integration configured (admin-only for now)
    if (this.user.isAdmin && this.user.blogIntegration && !enabledTools.includes('blog_edit')) {
      finalEnabledTools.push('blog_edit');
    }

    // Auto-add blog_draft tool for admin users (used by Content Publishing Studio)
    if (this.user.isAdmin && !enabledTools.includes('blog_draft')) {
      finalEnabledTools.push('blog_draft');
      hasContentTransform = true;
    }

    if (!enabledTools.includes('navigate_view') && shouldAutoEnableNavigateView(parsedBody.extraContextMessages)) {
      finalEnabledTools.push('navigate_view');
    }

    // Auto-add the `skill` LLM tool when the host has wired a skill repository.
    // Skills are user-defined instruction templates and there's no separate
    // toggle for them in the UI - gating purely on db.skills being present
    // keeps callers without skill support unaffected. SkillsFeature still
    // surfaces the catalog into the system prompt so the LLM knows what's
    // invocable.
    if (this.db.skills && !finalEnabledTools.includes('skill')) {
      finalEnabledTools.push('skill');
    }

    // Auto-add Lattice tools when Lattice feature is enabled
    if (parsedBody.enableLattice) {
      for (const tool of LATTICE_TOOL_NAMES) {
        if (!finalEnabledTools.includes(tool)) {
          finalEnabledTools.push(tool);
        }
      }
    }

    const { historyCount = DEFAULT_HISTORY_COUNT, enableQuestMaster, enableMementos, enableAgents } = parsedBody;

    logger.info(`⏱️ [0ms] Parsed request body - questId: ${questId}, sessionId: ${sessionId}`);

    return {
      parsedBody,
      quest,
      historyCount,
      enableQuestMaster,
      enableMementos,
      enableAgents,
      message,
      messageFileIds,
      sessionFabFileIds,
      params,
      enabledTools: finalEnabledTools,
      hasContentTransform,
      projectId,
      organizationId,
      questMaster,
      toolPromptId,
      researchMode,
      embeddingModel,
      queryComplexity,
      imageConfig,
      deepResearchConfig,
      userTimezone,
    };
  }

  /** Pipeline phase durations from the most recent process() call. Available after process() resolves. */
  public pipelinePhases: Record<string, number> | null = null;

  public async process({
    body,
    logger,
    prefetchedQuest,
    prefetchedSession,
    prefetchedOrganization,
    externalTools,
  }: {
    body: z.infer<typeof QuestStartBodySchema>;
    logger: Logger;
    /** Pre-fetched quest from invoke; avoids redundant DB read for wait=true path */
    prefetchedQuest?: IChatHistoryItemDocument;
    /** Pre-fetched session from invoke; avoids redundant DB read for wait=true path */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prefetchedSession?: any;
    /** Pre-fetched organization from invoke; avoids redundant DB read for wait=true path */
    prefetchedOrganization?: IOrganizationDocument | null;
    /** External tool definitions (e.g., Slack tools) that can't be serialized through EventBridge */
    externalTools?: Record<string, ToolDefinition>;
  }) {
    const processStartTime = Date.now();
    const timer = new PipelineTimer();
    timer.phase('init');
    logger.info('⏱️ === LLM COMPLETION PROCESS START ===');

    const initContext = await this.initializeProcessContext(body, logger, processStartTime, prefetchedQuest);
    const {
      parsedBody,
      quest,
      historyCount: initialHistoryCount,
      enableQuestMaster: initialEnableQuestMaster,
      enableMementos: initialEnableMementos,
      enableAgents: initialEnableAgents,
      message,
      messageFileIds,
      sessionFabFileIds,
      params,
      enabledTools,
      hasContentTransform,
      projectId,
      organizationId,
      questMaster,
      toolPromptId,
      researchMode,
      embeddingModel,
      queryComplexity,
      imageConfig,
      deepResearchConfig,
      userTimezone,
    } = initContext;
    let historyCount = initialHistoryCount;
    let enableQuestMaster = initialEnableQuestMaster;
    const enableMementos = initialEnableMementos;
    let enableAgents = initialEnableAgents;
    const { questId, sessionId } = parsedBody;

    // Variables to store actual timing durations
    let actualArtifactProcessingDuration = 0;
    let actualOnCompleteDuration = 0;
    const actualFinalSaveDuration = 0;

    // (P2b) Resolve rapid reply OFF the critical path. These lookups (findByQuestId + the
    // blank-quest fallback scan) previously blocked init for ~2-3s and almost always return
    // nothing. Kick them off here and await just before the streaming phase so they overlap
    // with context assembly instead of adding to time-to-first-token.
    const rapidReplyPromise = (async () => {
      let result = await this.db.rapidReply?.results.findByQuestId(questId);
      if (!result) {
        // No quest-scoped reply - check for a blank (pre-quest) reply in the last 10s on this session
        const blankRapidReply = await this.db.rapidReply?.results.findLatestBlankRapidReplyBySessionId(sessionId);
        if (blankRapidReply) {
          if (blankRapidReply.userId === this.user.id) {
            result = blankRapidReply;
          } else {
            logger.warn(
              `⚠️ [BLANK RAPID REPLY] userId mismatch: rapid reply belongs to ${blankRapidReply.userId}, current user is ${this.user.id}. Skipping.`
            );
          }
        }
      }
      return result;
    })().catch(err => {
      logger.warn('🔍 [RAPID REPLY] lookup failed (non-blocking):', err);
      return undefined;
    });
    let rapidReplyResult: Awaited<typeof rapidReplyPromise> | undefined = undefined;

    const saveQuest = async (quest: IChatHistoryItemDocument): Promise<IChatHistoryItemDocument | null> => {
      // Use the mutex to serialize the save operations
      return await questSaveMutex.runExclusive(async () => {
        // If quest has researchModeResults, ensure they're saved
        if (quest.researchModeResults?.length) {
          logger.info(
            `💾 [saveQuest] Saving quest ${quest.id} with ${quest.researchModeResults.length} Research Mode results`
          );
        }
        const result = await this.db.quests.update(quest);
        return result;
      });
    };

    const isSimpleQuery = queryComplexity === 'simple';
    logger.info(
      `🎯 [${Date.now() - processStartTime}ms] Query classified as: ${queryComplexity} ${
        isSimpleQuery ? '(fast-path enabled)' : ''
      }`
    );

    // Smart feature selection based on query complexity
    const getOptimizedFeatures = (complexity: QueryComplexityType): featureNames[] => {
      const baseFeatures: featureNames[] = [
        'slack',
        'summarizeNotebook',
        'autoNameSession',
        'mementos',
        'contextSummarization',
        // Skills is cheap: regex-parses the user message and is a no-op when
        // no `/` is present. Always-on so /skill invocations work even on
        // 'simple' queries.
        'skills',
      ]; // Always enabled, lightweight

      switch (complexity) {
        case 'simple':
          return baseFeatures; // Skip all expensive features for simple queries
        case 'contextual':
          return [...baseFeatures, 'agentDetection']; // Add agent detection for contextual queries (includes @mentions)
        case 'complex':
          return [...baseFeatures, 'mementos', 'questMaster', 'agentDetection']; // Full feature set
        default:
          return [...baseFeatures, 'agentDetection']; // Safe fallback
      }
    };

    let optimizedFeatureList = getOptimizedFeatures(queryComplexity as QueryComplexityType);

    // Honor explicit user enablement BEFORE any complexity-based optimizations.
    // When a user explicitly enables QuestMaster (toggle or New Quest flow) they want a
    // quest; user intent takes precedence over automatic optimization.
    const userExplicitlyEnabledQuestMaster = enableQuestMaster;
    const userExplicitlyEnabledAgents = enableAgents;

    // Add QuestMaster to feature list if user explicitly enabled it (regardless of query complexity)
    if (userExplicitlyEnabledQuestMaster && !optimizedFeatureList.includes('questMaster')) {
      optimizedFeatureList = [...optimizedFeatureList, 'questMaster'];
      logger.info(`🎯 [EXPLICIT_ENABLEMENT] QuestMaster explicitly enabled by user - adding to feature list`, {
        queryComplexity,
        sessionId,
      });
    }

    // Reduce features for simple queries, but NEVER override explicit user settings
    if (isSimpleQuery) {
      // Check if the message contains agent mentions before disabling agents
      // Note: Session agent attachment is already handled in classifyQueryComplexity
      // which receives session.agentIds and considers them when determining complexity
      const hasAgentMentions = message.includes('@');

      // Only disable QuestMaster if user did NOT explicitly enable it
      if (!userExplicitlyEnabledQuestMaster) {
        enableQuestMaster = false;
      }

      // Only disable agents if NOT explicitly enabled AND no @mentions
      // (attached agents are already handled by query complexity classification)
      if (!userExplicitlyEnabledAgents && !hasAgentMentions) {
        enableAgents = false;
      }

      // Reduce history for simple queries to optimize cost and performance
      // Use conservative fallback here; dynamic adjustment happens after modelInfo is available
      const originalHistoryCount = historyCount;
      historyCount = Math.min(historyCount, SIMPLE_QUERY_FALLBACK_MAX);

      if (originalHistoryCount > historyCount) {
        logger.info(`📉 [SIMPLE_QUERY] History pruned for simple query optimization`, {
          original: originalHistoryCount,
          reduced: historyCount,
          sessionId,
        });
      }

      logger.info(
        `🚀 [SIMPLE_QUERY] Optimizations: QuestMaster=${enableQuestMaster ? 'ON (explicit)' : 'OFF'}, Mementos=OFF, Agents=${enableAgents ? 'ON' : 'OFF'}, History=${historyCount}`
      );
    } else {
      // For complex queries, apply conservative cap before model info is available
      // Dynamic model-aware adjustment happens after modelInfo is fetched
      if (historyCount > COMPLEX_QUERY_FALLBACK_MAX) {
        logger.info(
          `📊 [COMPLEX_QUERY] Initial cap at ${COMPLEX_QUERY_FALLBACK_MAX} messages (will adjust based on model)`,
          {
            original: historyCount,
            capped: COMPLEX_QUERY_FALLBACK_MAX,
            sessionId,
          }
        );
        historyCount = COMPLEX_QUERY_FALLBACK_MAX;
      }
    }

    logger.info(`⏱️ [${Date.now() - processStartTime}ms] === PROGRESSIVE LOADING PHASE START ===`);

    // The final updated quest will be stored
    let finalQuest: IChatHistoryItemDocument | null = null;
    let cancelWatcherInterval: NodeJS.Timeout | null = null;
    let streamingHeartbeatInterval: NodeJS.Timeout | null = null;

    try {
      const abilityStartTime = Date.now();
      this.userAbility = this.abilityGetter(this.user);

      // Critical path: get only essential data for immediate LLM start
      timer.phase('essential_data');
      const essentialDataStartTime = Date.now();

      // Parallel fetch of all essential data.
      // Use pre-fetched session/org from invoke when available.
      // Security: API keys are always fetched fresh, never passed through EventBridge/SQS payloads.
      // Per-call timing so we can localize the essential_data long pole instead of guessing
      // (the combined number hides which of keys/session/org/models is slow). Temporary-ish
      // instrumentation: cheap, matches the existing timing log style.
      const timeCall = <T>(label: string, p: Promise<T> | T): Promise<T> => {
        const s = Date.now();
        // Promise.resolve() so a non-thenable value (e.g. a bare vi.fn() mock returning
        // undefined) is tolerated just like it would be inside Promise.all - the timing
        // wrapper must not change resolution semantics.
        return Promise.resolve(p).then(
          r => {
            logger.info(`⏱️ [essential:${label}] ${Date.now() - s}ms`);
            return r;
          },
          e => {
            logger.info(`⏱️ [essential:${label}] FAILED ${Date.now() - s}ms`);
            throw e;
          }
        );
      };

      const [session, organization, apiKeyTable] = await Promise.all([
        timeCall('session', Promise.resolve(prefetchedSession ?? this.db.sessions.findById(sessionId))),
        timeCall(
          'organization',
          prefetchedOrganization !== undefined
            ? Promise.resolve(prefetchedOrganization)
            : organizationId
              ? this.db.organizations.findById(organizationId)
              : Promise.resolve(null)
        ),
        timeCall('apiKeys', getEffectiveLLMApiKeys(this.user.id, { db: this.db, getSettingsByNames }, { logger })),
      ]);

      if (!session) {
        // Try to clean up the quest if session doesn't exist
        quest.status = 'stopped';
        quest.replies = ['Session not found. Please create a new session or refresh the page.'];
        await saveQuest(quest);
        return;
      }
      quest.status = 'running';

      // Generic per-session tool defaults: a session may carry tools that must
      // always be offered to the model, unioned with the per-request selection.
      // Lets a product surface guarantee grounded retrieval (or other tools)
      // regardless of the client's Smart/Fast toggle. No product-specific branch
      // in core - mirrors the generic `session.systemPromptText` capability.
      if (Array.isArray(session.enabledTools)) {
        for (const tool of session.enabledTools) {
          if (!enabledTools.includes(tool)) enabledTools.push(tool);
        }
      }

      // Generic per-session tool denylist: strip tools the session forbids, even if
      // the request or a global auto-add (e.g. navigate_view) included them. Lets a
      // product surface enforce an approved toolset ("curated sources only" -> no web
      // search). Applied last so it wins over every other tool source. Mutates in
      // place since `enabledTools` is the array reference passed to buildTools.
      if (Array.isArray(session.disabledTools) && session.disabledTools.length > 0) {
        const denied = new Set(session.disabledTools);
        for (let i = enabledTools.length - 1; i >= 0; i--) {
          if (denied.has(enabledTools[i])) enabledTools.splice(i, 1);
        }
      }

      // Generic per-session integration isolation: a curated-surface session (e.g. /opti)
      // can suppress the user's personal integrations so it runs only its server-owned
      // toolset - no user MCP servers, no agent delegation. No product-specific branch in
      // core; mirrors the generic `enabledTools`/`disabledTools` capability above.
      if (session.disableUserIntegrations) {
        enableAgents = false;
        parsedBody.mcpServers = [];
      }

      // Start model info, admin settings, and quest save in parallel
      const [, models, defaultAdminSettings] = await Promise.all([
        // Quest save can be async - don't block on it
        timeCall('saveQuest', Promise.resolve(saveQuest(quest))),
        // Get available models in parallel
        timeCall('models', getAvailableModels(apiKeyTable)),
        // Admin settings have NO dependency on models, load in parallel
        timeCall('adminSettings', this.loadAdminSettingsAsync(logger, processStartTime)),
      ]);

      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Essential data + API keys + models fetched in parallel in ${
          Date.now() - essentialDataStartTime
        }ms`
      );

      const throttledSend = DISABLE_SERVER_THROTTLING
        ? () => this.sendStatusUpdate(quest, null) // No throttling - direct send
        : throttle(
            () => {
              return this.sendStatusUpdate(quest, null);
            },
            THROTTLE_INTERVAL,
            { leading: true }
          );

      // Streaming heartbeat: persist quest state to MongoDB every 10s during streaming.
      // Without this, quest.replies and quest.updatedAt stay stale until completion, so a mid-stream
      // refresh shows an empty quest and the check-timeout endpoint falsely marks it as stuck.
      let heartbeatFailureStreak = 0;
      streamingHeartbeatInterval = setInterval(() => {
        if (quest.status === 'done') return; // Final save handles this — avoid racing
        void saveQuest(quest)
          .then(() => {
            heartbeatFailureStreak = 0;
          })
          .catch(err => {
            heartbeatFailureStreak += 1;
            // Escalate to error once consecutive failures cross the threshold so degraded
            // MongoDB availability mid-stream surfaces in alerting, not just warn logs.
            if (heartbeatFailureStreak >= STREAMING_HEARTBEAT_ERROR_ESCALATION_THRESHOLD) {
              logger.error(
                `[heartbeat] Quest ${quest.id} persistence failing for ${heartbeatFailureStreak} consecutive heartbeats:`,
                err
              );
            } else {
              logger.warn(`[heartbeat] Failed to persist streaming quest ${quest.id}:`, err);
            }
          });
      }, STREAMING_HEARTBEAT_INTERVAL_MS);

      // PERFORMANCE OPTIMIZATION: Simple content-aware sending without complex batching
      let lastSendTime = 0;

      const smartSend = () => {
        // Replies with thinking models consist of two items, the first is the thinking reply and the second is the actual reply.
        // We would always pick the last item on the array here
        const currentContent = quest.replies?.[quest.replies.length - 1] || '';
        const now = Date.now();

        // Forward the latest visible reply to any streaming consumer (Voice v2 SSE).
        this.onReplyStream?.(currentContent);

        // Always send completion immediately
        if (quest.status === 'done') {
          lastSendTime = now;
          logger.info(`📤 [STREAMING] Final message sent, content length: ${currentContent.length}`);
          throttledSend();
          return;
        }

        throttledSend();

        const timeSinceLastSend = now - lastSendTime;

        if (timeSinceLastSend > THROTTLE_INTERVAL) {
          lastSendTime = Date.now();
        }
      };

      logger.info(`⏱️ [${Date.now() - processStartTime}ms] Using default admin settings (loaded in parallel)`);

      // Send an initial status update
      const statusUpdateStartTime = Date.now();
      this.sendStatusUpdate(quest, 'Spinning up...', { statusAt: new Date() });
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Initial status update sent in ${Date.now() - statusUpdateStartTime}ms`
      );

      // Quest save already completed in Promise.all above, no redundant save needed

      // Build optimized features based on query complexity
      timer.phase('features_build');
      const featureBuildStartTime = Date.now();
      await this.buildOptimizedFeatures(
        defaultAdminSettings,
        enableQuestMaster || false,
        enableMementos || false,
        enableAgents || false,
        projectId,
        optimizedFeatureList,
        organization,
        session.systemPromptText,
        session.forceKnowledgeRetrieval,
        session.retrievalTags,
        session.citationStyle
      );
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Optimized features built (${optimizedFeatureList.join(', ')}) in ${
          Date.now() - featureBuildStartTime
        }ms`
      );

      const logEventStartTime = Date.now();
      this.logEvent(
        {
          userId: this.user.id,
          type: LLMEvents.QUEUE_HANDLER_START_HEARD_PROMPT,
          metadata: { sessionId, questId, promptMessage: message },
        },
        { ability: this.userAbility }
      );
      logger.info(`⏱️ [${Date.now() - processStartTime}ms] Log event completed in ${Date.now() - logEventStartTime}ms`);

      const { model, stream = true } = params;

      logger.updateMetadata({ model: params.model });

      // API keys and models already fetched in parallel above - no need to refetch
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Using parallel-fetched API keys and models (skipped redundant fetch)`
      );

      const modelSetupStartTime = Date.now();
      // Upgrade a deprecated/retired model id (e.g. a session still pinned to a sunset snapshot)
      // to its modern equivalent before lookup. getAvailableModels filters retired ids out, so
      // without this the find returns undefined and the run dies with "Invalid LLM backend".
      const resolvedModelId = resolveDeprecatedModelId(model, 'ChatCompletionProcess');
      const modelInfo = models.find(m => m.id === resolvedModelId);
      const llm = getLlmByModel(apiKeyTable, {
        modelInfo,
        logger,
        endUserId: this.user.id,
      });

      if (!modelInfo || !llm) {
        throw new Error('Invalid LLM backend specified');
      }
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Model setup completed in ${
          Date.now() - modelSetupStartTime
        }ms - using ${model}`
      );

      // Dynamic history adjustment: now that we have modelInfo, adjust history count
      // based on model's actual context window
      const contextWindow = modelInfo.contextWindow ?? 200000;

      // Image models generate from the current prompt alone: the image backend
      // ignores conversation history. Sending history only inflates the token count
      // and trips a false context-overflow against the image model's small context
      // window (e.g. FLUX Pro 1.1 at 10k).
      if (modelInfo.type === 'image') {
        historyCount = 0;
      }

      const modelAwareMax = isSimpleQuery
        ? getSimpleQueryMaxHistory(contextWindow)
        : getComplexQueryMaxHistory(contextWindow);

      if (historyCount > modelAwareMax) {
        logger.info(`📊 [DYNAMIC_HISTORY] Adjusting history based on model context window`, {
          model,
          contextWindow,
          previousHistoryCount: historyCount,
          modelAwareMax,
          queryType: isSimpleQuery ? 'simple' : 'complex',
        });
        historyCount = modelAwareMax;
      } else if (historyCount < modelAwareMax) {
        // Allow expansion up to model-aware max if original request was lower
        logger.info(`📊 [DYNAMIC_HISTORY] Model supports more history than requested`, {
          model,
          contextWindow,
          requestedHistory: historyCount,
          modelAwareMax,
          queryType: isSimpleQuery ? 'simple' : 'complex',
        });
      }

      // Use default admin settings for immediate processing
      const adminModerationEnabled = this.getDefaultSettingValue('ModerationEnabled', defaultAdminSettings);
      const adminSettingsEnforceCredits = this.getDefaultSettingValue('enforceCredits', defaultAdminSettings);
      const enableMCPServer = this.getDefaultSettingValue('EnableMCPServer', defaultAdminSettings);
      if (adminSettingsEnforceCredits && !this.db.creditTransactions) {
        throw new BadRequestError('Enforce credits is enabled but credit transactions are not available');
      }

      // Context Telemetry: Initialize builder if telemetry is enabled
      // Fetch this setting fresh (bypass cache) to ensure immediate response to toggle changes
      const telemetryEnabledRaw = await getSettingByName('EnableContextTelemetry', this.db, {
        logger,
        skipCache: true,
      });
      // Note: getSettingByName returns string | null but boolean settings may return actual boolean
      // Cast to unknown first to handle both cases safely
      const telemetryEnabled =
        (telemetryEnabledRaw as unknown) === true ||
        telemetryEnabledRaw === 'true' ||
        telemetryEnabledRaw === '1' ||
        telemetryEnabledRaw === 'True';
      logger.info(
        `📊 [Telemetry] EnableContextTelemetry check - raw: ${telemetryEnabledRaw} (${typeof telemetryEnabledRaw}), parsed: ${telemetryEnabled}`
      );
      let telemetryBuilder: TelemetryBuilder | undefined;

      if (telemetryEnabled) {
        // Check GPC signal (CCPA/CPRA requires honoring Sec-GPC: 1 header)
        if (this.gpcSignalDetected) {
          logger.info(`📊 [Telemetry] Global Privacy Control signal detected, skipping telemetry for this request`);
        }
        // Check user-level telemetry preference (three-tier: none/basic/enhanced)
        const telemetryLevel = this.user.preferences?.contextTelemetryLevel ?? 'basic';
        if (this.gpcSignalDetected || telemetryLevel === 'none') {
          if (telemetryLevel === 'none') {
            logger.info(`📊 [Telemetry] User opted out of context telemetry, skipping`);
          }
        } else {
          try {
            // Derive daily salt from HMAC secret (rotates daily via dateKey)
            const dateKey = new Date().toISOString().split('T')[0];
            const dailySalt =
              this.telemetryHmacSecret && this.telemetryHmacSecret !== 'not-configured'
                ? createHmac('sha256', this.telemetryHmacSecret).update(dateKey).digest('hex')
                : `telemetry-salt-${dateKey}`; // Fallback for local dev without secret configured
            const anonymousSessionId = generateAnonymousSessionId(
              this.user.id,
              organization?.id ?? 'default',
              dailySalt
            );

            telemetryBuilder = new TelemetryBuilder(anonymousSessionId);
            telemetryBuilder.setCaptureLevel(telemetryLevel);

            // Set requested model info
            telemetryBuilder.setRequestedModel(modelInfo.id, mapBackendToProvider(modelInfo.backend));

            // Set thinking mode if applicable (will be updated later if reasoning is enabled)
            const usesThinking = modelInfo.can_think ?? false;
            telemetryBuilder.setThinking(usesThinking);

            logger.info(`📊 [Telemetry] Initialized context telemetry (level=${telemetryLevel}) for quest ${questId}`);
          } catch (telemetryError) {
            // Telemetry errors should never block the main flow
            logger.warn(`📊 [Telemetry] Failed to initialize telemetry:`, telemetryError);
          }
        }
      }

      // Enforce per-user moderation escalation state. Runs regardless of the
      // ModerationEnabled admin toggle: an escalation, once set, always applies.
      //  - `suspended`: generation blocked outright.
      //  - `throttled` (within its window) or `suspend_pending` (awaiting human review):
      //    a tightened generation rate limit. `suspend_pending` is intentionally the more
      //    severe state, so it must stay at least as constrained as `throttled`.
      const moderationState = this.user.moderation;
      if (moderationState?.status === 'suspended') {
        throw new ForbiddenError(
          'Your account is suspended for repeated content-policy violations. Please contact support to appeal.'
        );
      }
      const throttleWindowActive =
        moderationState?.status === 'throttled' &&
        !!moderationState.throttledUntil &&
        new Date(moderationState.throttledUntil).getTime() > Date.now();
      if (throttleWindowActive || moderationState?.status === 'suspend_pending') {
        if (this.cacheRepository) {
          const { success } = await this.cacheRepository.tryIncrementWithinLimitFixedWindow(
            moderationThrottleKey(this.user.id),
            MODERATION_POLICY.throttleRateLimit,
            MODERATION_POLICY.throttleRateWindowMs
          );
          if (!success) {
            throw new TooManyRequestsError(
              'Your account is temporarily rate-limited due to repeated content-policy violations. Please try again later.'
            );
          }
        } else {
          logger.warn(
            `🚦 [Moderation] User ${this.user.id} is ${moderationState?.status} but no cacheRepository is available to enforce the rate limit`
          );
        }
      }

      if (adminModerationEnabled) {
        const moderationStartTime = Date.now();
        // Only run OpenAI moderation if we have an OpenAI key available
        if (apiKeyTable?.openai) {
          try {
            await new OpenaiModerationsService(apiKeyTable.openai, logger).checkPrompt(message);
          } catch (moderationError) {
            // On a flag, record a per-user moderation hit and auto-escalate (throttle to
            // suspend_pending) BEFORE rethrowing to block this prompt. Recording
            // must never mask the block, so its own failure is swallowed with a warning.
            if (moderationError instanceof FlaggedContentError) {
              try {
                const decision = await applyModerationHit({
                  users: this.db.users,
                  userId: this.user.id,
                  hit: { at: new Date(), categories: moderationError.categories, source: 'openai', questId },
                });
                logger.warn(
                  `🚦 [Moderation] User ${this.user.id} flagged (${moderationError.categories.join(', ')}); ` +
                    `${decision.hitsInWindow} hit(s) in window → status ${decision.status}`
                );
              } catch (recordError) {
                logger.error(`🚦 [Moderation] Failed to record moderation hit for user ${this.user.id}:`, recordError);
              }
            }
            throw moderationError;
          }
          logger.info(
            `⏱️ [${Date.now() - processStartTime}ms] Moderation check completed in ${
              Date.now() - moderationStartTime
            }ms`
          );
        } else {
          logger.info(
            `⏱️ [${
              Date.now() - processStartTime
            }ms] Skipping OpenAI moderation - no OpenAI key available for model ${model}`
          );
        }
      }

      // Check if any feature wants to take over processing (run in parallel!)
      timer.phase('features_before');
      const featureResults = await Promise.all(
        Array.from(this.features.entries()).map(async ([name, feature]) => {
          const featureStartTime = Date.now();
          try {
            const result = await feature.beforeDataGathering({
              quest,
              session,
              startParams: params,
              llm,
              model,
              message,
              historyCount,
              fabFileIds: sessionFabFileIds,
              questId,
              questMaster,
            });

            const elapsed = Date.now() - featureStartTime;
            logger.info(
              `⏱️ [${Date.now() - processStartTime}ms] Feature '${name}' beforeDataGathering completed in ${elapsed}ms`
            );

            return { name, result, elapsed };
          } catch (error) {
            logger.error(`Feature '${name}' beforeDataGathering failed:`, error);
            return { name, result: { shouldContinue: true }, elapsed: Date.now() - featureStartTime };
          }
        })
      );

      // Check if any feature wants to take over
      const takeoverFeature = featureResults.find(({ result }) => result?.shouldContinue === false);
      if (takeoverFeature) {
        logger.log(`✅ Feature '${takeoverFeature.name}' has taken over processing`);
        this.sendStatusUpdate(quest, null, { immediate: true });
        return;
      }

      const totalFeatureTime = featureResults.reduce((sum, { elapsed }) => sum + elapsed, 0);
      const maxFeatureTime = Math.max(...featureResults.map(({ elapsed }) => elapsed));
      logger.info(
        `⏱️ [${
          Date.now() - processStartTime
        }ms] All features completed in parallel: ${maxFeatureTime}ms max, ${totalFeatureTime}ms total work (${Math.round(
          (totalFeatureTime / maxFeatureTime) * 100
        )}% parallelization efficiency)`
      );

      // Step 2: Fetching and Processing Previous Messages + Start Context Loading in Parallel
      timer.phase('history');
      const historyStartTime = Date.now();
      this.sendStatusUpdate(quest, 'Reviewing previous messages...', { statusAt: new Date() });

      const finalEmbeddingModel = embeddingModel || OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002;

      const embeddingFactory = new EmbeddingFactory({
        ...(finalEmbeddingModel === OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002 && {
          openaiApiKey: apiKeyTable?.openai,
        }),
        ...(finalEmbeddingModel === VoyageAIEmbeddingModel.VOYAGE_3 && {
          voyageApiKey: apiKeyTable?.voyageai,
        }),
      });

      // Fetch previous messages
      const previousMessagesResult = await fetchAndProcessPreviousMessages(session, historyCount, { db: this.db });
      const [previousMessages, totalMessageCount, cacheInfo] = previousMessagesResult;
      const oldestIncludedQuestId = cacheInfo.oldestIncludedQuestId ?? null;

      // Local (Ollama) models run on modest hardware with small context budgets and
      // are easily derailed by prose that isn't about the task. Give them a leaner
      // system prompt: drop the Bike4Mind product-pitch persona (injected as an
      // extraContextMessage) and the help-center nudge (below). Provider models are
      // unaffected and keep the full prompt.
      const isLocalModel = modelInfo.backend === ModelBackend.Ollama;

      // Extract extraContextMessages from Slack or other sources (will be added to context later)
      const extraContextMessages = (parsedBody.extraContextMessages || []).filter(
        m => !(isLocalModel && typeof m.content === 'string' && m.content.includes('[ADMIN_PROMPT:bike4mind_identity]'))
      );
      if (extraContextMessages.length > 0) {
        logger.debug(
          `📨 [EXTRA_CONTEXT] Received ${extraContextMessages.length} extra context messages from external source`
        );
      }

      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Previous messages loaded in ${
          Date.now() - historyStartTime
        }ms ${cacheInfo?.cacheHit ? '🎯 CACHE_HIT' : '💾 CACHE_MISS'}`
      );

      // Warn if session is getting very long (suggest new session or summary)
      // See SESSION_LENGTH_WARNING_THRESHOLD constant for rationale
      if (totalMessageCount > SESSION_LENGTH_WARNING_THRESHOLD) {
        logger.warn('⚠️ Session has exceeded recommended length', {
          totalMessageCount,
          recommendedMax: SESSION_LENGTH_WARNING_THRESHOLD,
          sessionId,
          userId: this.user.id,
          recommendation:
            'Consider starting a new session for better performance and cost efficiency. Session summaries can help preserve important context.',
        });
      }

      // Start with some default values and decode the parameters
      const {
        temperature = 0.9,
        top_p: topP = 1,
        n = 1,
        max_tokens: maxTokens,
        // presence_penalty = 0,
        // frequency_penalty = 0,
        logit_bias: logitBias = null,
        thinking,
      } = params;

      // Generic per-session temperature override: a session can pin a fixed
      // temperature (e.g. a regulated reference product wanting lower variance for
      // clinical accuracy) that wins over the request's value. Mirrors the other
      // session-scoped capabilities; no product-specific branch in core.
      const effectiveTemperature = typeof session.temperature === 'number' ? session.temperature : temperature;

      // Step 3: Fetching and Converting Fab Files (Feature contexts already loaded above)
      timer.phase('data_sources');
      this.sendStatusUpdate(quest, 'Gathering data sources...', { statusAt: new Date() });
      const dataSources = await this.buildDataSources({
        defaultAdminSettings,
        sessionFabFileIds,
        messageFileIds,
        sessionKnowledgeIds: session.knowledgeIds ?? [],
        message,
        maxTokens,
        quest,
        embeddingFactory,
        modelInfo,
        logger,
        processStartTime,
      });
      const {
        urlMessages,
        remainingUserPrompt,
        fabMessages,
        convertedFabFiles,
        globalSystemFileIds,
        enabledSystemFileIds,
        allFileIdsBeforeDedup,
        dedupedFileIds,
        featureContextMessages,
      } = dataSources;

      // Step 5b: Build MCP tools and tool prompts before message assembly
      timer.phase('tool_setup');

      // Mutable holder for the abort signal - assigned later when the AbortController
      // is created, but accessible via closure by the delegate_to_agent tool at invocation time.
      const abortSignalHolder: { signal?: AbortSignal } = {};

      // Resolve entitlement keys once before building tools so the knowledge tools'
      // data-lake access (getDynamicDataLakeAccess) sees the same keys as forced retrieval.
      const entitlementKeys = await this.resolveEntitlementKeys();

      const toolBuilder = new ToolBuilder({
        user: this.user,
        db: this.db,
        entitlementKeys,
        logger: this.logger,
        storage: this.storage,
        imageGenerateStorage: this.imageGenerateStorage,
        imageProcessorLambdaName: this.imageProcessorLambdaName,
        getMcpClient: this.getMcpClient,
        toolCreditsMap: this.toolCreditsMap,
        subagentTelemetryData: this.subagentTelemetryData,
        sendStatusUpdate: (q, status, options) => this.sendStatusUpdate(q, status, options),
        onToolPreamble: this.onToolPreamble,
      });

      const { mcpToolsByServer, serverAgentConfig } = await toolBuilder.buildMcpTools({
        enableMCPServer,
        requestedMcpServers: parsedBody.mcpServers,
        defaultAdminSettings,
        userMessage: initContext.message,
        logger,
        processStartTime,
        quest,
      });

      // Construct per-request agent store with user-specific config (e.g., selected repositories)
      const fullAgentStore = new ServerAgentStore(serverAgentConfig);

      // Gate `delegate_to_agent` on explicit user intent. Without this gate,
      // the tool was auto-injected on every chat completion and the model could
      // autonomously spawn subagent runs that burn millions of tokens on benign
      // prompts (live trace on the PR preview: a "compare smartphones" prompt
      // self-delegated to the researcher agent, burned 3.97M tokens over 75s, and
      // rolled up as 17,990 credits - all without any @mention or attached agent).
      //
      // The Smart Routing system is the intentional path into agent_executor;
      // this gate only affects the regular chat path, where delegate_to_agent had
      // been a silent side-channel.
      //
      // We expose delegation only when the user actually asked for it:
      //   - caller passed an explicit `allowedAgents` allowlist (persona surfaces
      //     that scope the agent set), OR
      //   - the user typed `@agent` in this turn's message, OR
      //   - the user attached an agent to the session via the UI.
      // Otherwise `agentStore` is undefined and both `sharedToolBuilder` and the
      // tool-prompt builder skip injecting the delegation surface entirely.
      //
      // An explicit `allowedAgents: []` is treated as "no delegation requested"
      // rather than "delegation requested with no allowed agents" - the latter
      // would expose `delegate_to_agent` to the model but give it nothing to
      // delegate to, which is strictly worse than suppressing the tool.
      // Predicate order is cheap-first: allowedAgents/session.agentIds are O(1)
      // property reads; detectAgentMentions runs a regex over the prompt.
      const hasAllowedAgentsAllowlist = (parsedBody.allowedAgents?.length ?? 0) > 0;
      const hasSessionAgent = (session.agentIds?.length ?? 0) > 0;
      // A curated surface that suppresses user integrations (session.disableUserIntegrations)
      // must never delegate to agents - force this off so `agentStore` stays undefined and
      // `delegate_to_agent` is never injected, regardless of allowedAgents / session.agentIds /
      // @mentions (none of which consult `enableAgents`). This makes the field honor its
      // "no agent delegation" contract self-sufficiently; the disabledTools denylist below is
      // the second layer of defense.
      const userRequestedDelegation =
        !session.disableUserIntegrations &&
        (hasAllowedAgentsAllowlist || hasSessionAgent || detectAgentMentions(message).length > 0);
      const agentStore = !userRequestedDelegation
        ? undefined
        : hasAllowedAgentsAllowlist
          ? fullAgentStore.getFilteredStore(parsedBody.allowedAgents!)
          : fullAgentStore;
      const agentOnlyMcpServers = fullAgentStore.getExclusiveMcpServers();

      // P7-a: Early-exit when there are no files to process
      // The majority of messages have no attachments - skip the entire data sources
      // phase (status updates, URL parsing, fab file fetching) when there's nothing to do.
      if (dedupedFileIds.length === 0) {
        // No files - still need to check for URLs in the message
        const urlResult = await processUrlsFromPrompt(
          message,
          maxTokens,
          this.user.id,
          async status => {
            this.sendStatusUpdate(quest, status, { statusAt: new Date() });
          },
          this.logger
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dataSources as any).urlMessages = urlResult.userMessages;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dataSources as any).remainingUserPrompt = urlResult.remainingPrompt;
      }

      let allTools = toolBuilder.buildTools({
        enabledTools,
        mcpToolsByServer,
        quest,
        saveQuest,
        llm,
        config: {
          deep_research: {
            ...deepResearchConfig,
            model,
            apiKeys: apiKeyTable,
          },
          image_generation: imageConfig,
          edit_image: imageConfig,
        },
        model,
        organization,
        precomputed: {
          adminSettingsEnforceCredits: !!adminSettingsEnforceCredits,
          models,
        },
        agentOnlyMcpServers,
        apiKeyTable,
        getAbortSignal: () => abortSignalHolder.signal,
        thinking: thinking ? { enabled: thinking.enabled, budget_tokens: thinking.budget_tokens ?? 16000 } : undefined,
        agentStore,
        externalTools,
      });

      // Final denylist pass on the built tool list. The enabledTools filter above
      // can't catch tools injected inside buildTools (e.g. the auto-added
      // delegate_to_agent), so strip any session-forbidden tools here too - this
      // closes loopholes like a research subagent web-searching on a "curated
      // sources only" surface.
      if (Array.isArray(session.disabledTools) && session.disabledTools.length > 0 && allTools) {
        const denied = new Set(session.disabledTools);
        allTools = allTools.filter(t => !denied.has(t.toolSchema.name));
      }

      // Local (Ollama) models are small and easily confused by tools they weren't
      // asked to use - they pick the wrong one or loop. Restrict them to the tools
      // the user explicitly enabled, dropping the auto/admin-added extras
      // (blog_draft, skill, navigate_view, blog_publish/edit) unless selected.
      if (modelInfo.backend === ModelBackend.Ollama && allTools) {
        const userSelected = new Set<string>(parsedBody.tools ?? []);
        const before = allTools.length;
        allTools = allTools.filter(
          t => !AUTO_ADDED_TOOL_NAMES.includes(t.toolSchema.name) || userSelected.has(t.toolSchema.name)
        );
        if (allTools.length !== before) {
          logger.info(
            `🔧 [Tools] Trimmed ${before - allTools.length} auto-added tool(s) for local model ${modelInfo.id}`
          );
        }
      }

      logger.info('🔧 [Tools] allTools:', {
        count: allTools?.length ?? 0,
        names: allTools?.map(t => t.toolSchema.name) ?? [],
      });

      // For tool prompt guidance, only include MCP tools given directly to the main LLM
      // (agent-only tools like Atlassian are excluded - they're accessed via delegate_to_agent)
      const directMcpTools = Object.entries(mcpToolsByServer)
        .filter(([serverName]) => !agentOnlyMcpServers.includes(serverName))
        .flatMap(([, tools]) => tools);

      const toolPromptMessage = await toolBuilder.buildToolPrompt({
        toolPromptId,
        hasContentTransform: hasContentTransform ?? false,
        hasChessEngine: enabledTools.includes('chess_engine'),
        hasCurrentDateTime: enabledTools.includes('current_datetime'),
        userTimezone,
        mcpTools: directMcpTools,
        sessionId,
        message,
        logger,
        processStartTime,
        agentStore,
        extraContextMessages,
      });

      logger.info(`⏱️ [${Date.now() - processStartTime}ms] === TOOLS SETUP ===`);

      // Step 6: Building and Sorting Messages
      timer.phase('message_building');
      const messageBuildingStartTime = Date.now();
      // Calculate safe input token limits BEFORE building messages
      const contextLimit = modelInfo.contextWindow ?? 200000;
      const modelMaxOutputTokens = modelInfo.max_tokens ?? 16384;
      let safeMaxTokens = maxTokens;

      if (maxTokens > modelMaxOutputTokens) {
        safeMaxTokens = modelMaxOutputTokens;
      }

      const safetyBuffer = 1000; // Emergency buffer
      const maxSafeInputTokens = contextLimit - safeMaxTokens - safetyBuffer;

      // Generate current date context for the AI.
      // Use user's browser timezone if available, otherwise fall back to server timezone.
      //
      // DAY granularity only, deliberately NO clock time. This block sits inside the
      // cached system prefix: the Anthropic caching adapter marks the LAST system block with
      // cache_control (caching/adapters/anthropic.ts applyCaching), so every system message
      // before that breakpoint is part of the cached region - including this one, wherever
      // buildAndSortMessages ends up ordering it (upstream helpers there may prepend hardcoded/
      // artifact/image system messages ahead of it). A minute-precision timestamp anywhere in
      // that region changed the prefix bytes every minute, busting the ~3k-token system-prompt
      // cache on every minute boundary: warm follow-ups then almost never earned a provider
      // cache READ, so the cache-read discount had nothing to re-rate (verified on the
      // preview - reads were absent/erratic across minute boundaries). Day granularity
      // keeps the prefix byte-stable for a full day (busts only at local midnight), mirroring
      // the daily-salt pattern already used for telemetry (dateKey = new Date().toISOString().split('T')[0]).
      const now = new Date();
      const dateFormatOptions: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        ...(userTimezone && { timeZone: userTimezone }),
      };
      const dateTimeContext = {
        role: 'system' as const,
        content: `Current date: ${now.toLocaleDateString('en-US', dateFormatOptions)}`,
      };
      logger.debug(`🕐 Date context (tz=${userTimezone || 'server'}): ${dateTimeContext.content}`);

      // Ensure user message is always present - when remainingUserPrompt is empty (URL-only
      // prompts), fall back to original message. URL content is still included via urlMessages.
      const effectiveUserPrompt = remainingUserPrompt || message;
      if (!remainingUserPrompt && urlMessages.length > 0) {
        logger.debug('User prompt was URL-only, using original message for LLM context', {
          originalMessagePreview: message.substring(0, 100),
        });
      }

      let messages = await buildAndSortMessages(
        previousMessages,
        [
          dateTimeContext, // Always provide current date/time awareness
          ...extraContextMessages, // Add extra context messages from external sources at the top
          // Artifact emission guidance. Without this, correct <artifact> usage
          // is left to the model's defaults and large HTML/code can leak into the chat
          // body as raw markup. Gated on the same EnableArtifacts flag as extraction.
          ...(getSettingsValue('EnableArtifacts', defaultAdminSettings)
            ? [
                {
                  role: 'system' as const,
                  // Admin-editable via the `ArtifactEmissionPrompt` setting (general AI settings);
                  // falls back to the built-in ARTIFACT_EMISSION_PROMPT default when unset/cleared,
                  // so a blank value can never strip artifact guidance from completions.
                  content: getSettingsValue('ArtifactEmissionPrompt', defaultAdminSettings, ARTIFACT_EMISSION_PROMPT),
                },
              ]
            : []),
          // Help-center awareness. Makes the model aware of the in-app
          // Help Center so a user who types a how-to question ("how do I add to my data lake?")
          // gets pointed to it instead of an ungrounded guess. Admin-editable via the
          // `HelpCenterPrompt` setting; a blank value falls back to the built-in default so the
          // nudge can never be silently stripped. Skipped for local models (lean prompt).
          ...(isLocalModel
            ? []
            : [
                {
                  role: 'system' as const,
                  content: getSettingsValue('HelpCenterPrompt', defaultAdminSettings, HELP_CENTER_PROMPT),
                },
              ]),
          // Inject view registry summary when navigate_view tool is enabled
          ...(enabledTools.includes('navigate_view')
            ? [
                {
                  role: 'system' as const,
                  content: (() => {
                    // Extract current path from extraContextMessages for context-aware prompting
                    const viewCtx = extraContextMessages.find(
                      m => typeof m.content === 'string' && m.content.includes('[Current View Context]')
                    );
                    const ctxStr = typeof viewCtx?.content === 'string' ? viewCtx.content : '';
                    const currentPath = ctxStr.match(/Path:\s*(\S+)/)?.[1] || '';
                    let summary = getViewSummaryForLLM({ isAdmin: this.user?.isAdmin });
                    // Add path-specific emphasis
                    if (currentPath.startsWith('/admin')) {
                      summary +=
                        '\n\nThe user is currently on the Admin page. When they ask about any admin feature, you MUST call navigate_view with the matching admin.* tab.';
                    }
                    return summary;
                  })(),
                },
              ]
            : []),
          ...(toolPromptMessage ? [toolPromptMessage] : []), // Tool prompt, blog draft, MCP guidance, conversation context, agent delegation
          ...(featureContextMessages['agentDetection'] ?? []), // Add agent system prompts
          ...(featureContextMessages['questMaster'] ?? []),
          ...(featureContextMessages['organizationPrompt'] ?? []), // Add team-wide system prompt
          ...(featureContextMessages['sessionPrompt'] ?? []), // Per-session system prompt (product surfaces)
          ...(featureContextMessages['knowledgeRetrieval'] ?? []), // Forced data-lake retrieval (grounding + citations)
          // Add LLM-optimized context summary if available (covers messages before verbatim window)
          ...(session.contextSummary
            ? [
                {
                  role: 'system' as const,
                  content: `[Context from earlier in this conversation]\n${session.contextSummary}`,
                },
              ]
            : []),
          ...(featureContextMessages['mementos'] ?? []),
          ...(featureContextMessages['project'] ?? []),
          // Recently generated images - gives the model a handle to edit a prior
          // generated image ("make it cartoonish"). Generated images persist as
          // bare storage keys in quest.images with no fabFile record, so without
          // this note the model can't reference them and either declines or (worse)
          // claims success without calling a tool. Gated on edit_image being
          // available (paired with image_generation).
          ...(enabledTools.includes('edit_image') && (cacheInfo.recentGeneratedImages?.length ?? 0) > 0
            ? [
                {
                  role: 'system' as const,
                  content: [
                    '# Recently generated images',
                    '',
                    'You generated these image(s) earlier in this conversation. To modify one (change style, angle, colors, etc.), call edit_image with `image` set to the EXACT id shown (for a previously generated image, that bare key is the handle to use):',
                    '',
                    ...cacheInfo.recentGeneratedImages!.map(
                      img => `- ${img.key}${img.prompt ? ` — from: "${img.prompt}"` : ''}`
                    ),
                    '',
                    'Never claim you created or edited an image unless image_generation or edit_image actually returned successfully in this turn.',
                  ].join('\n'),
                },
              ]
            : []),
          ...urlMessages,
          ...fabMessages,
        ],
        [{ role: 'user', content: effectiveUserPrompt }],
        maxSafeInputTokens,
        defaultAdminSettings,
        historyCount,
        logger,
        this.tokenizer
      );
      if (!messages) {
        throw new Error('No messages to send to OpenAI');
      }

      // Phase 2: Capture message truncation debug info
      const messageTruncationInfo = getLastBuildDebugInfo();
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Message building completed (${messages.length} total messages) in ${
          Date.now() - messageBuildingStartTime
        }ms`
      );

      // Step 6: Creating and Handling Completion
      const completionSetupStartTime = Date.now();
      this.sendStatusUpdate(quest, 'Generating insights...', { statusAt: new Date() });

      this.logEvent(
        {
          userId: this.user.id,
          type: LLMEvents.QUEUE_HANDLER_START_MODEL,
          counterValue: n,
          // source: 'web' covers all callers of ChatCompletionProcess today
          // (chat UI, Slack quest processor, agent executor). If we later need
          // to distinguish agent/slack flows, thread source through the
          // constructor and override here.
          metadata: { sessionId, questId, modelName: model, source: 'web' },
        },
        { ability: this.userAbility }
      );

      const replies: { [key: number]: string } = {};
      for (let i = 0; i < n; i++) {
        replies[i] = '';
      }

      // Calculate input tokens and per-source breakdown in parallel
      const tokenCalculationStartTime = Date.now();
      const tokenCalcOptions = { estimateOnly: false, tokenizer: this.tokenizer };
      let tokensBySource:
        | {
            systemPrompts: number;
            conversationHistory: number;
            mementos: number;
            fabFiles: number;
            urlContent: number;
            toolSchemas: number;
            userPrompt: number;
          }
        | undefined;

      const mementoMessages = featureContextMessages['mementos'] ?? [];
      let inputTokens = 0;

      try {
        const [totalTokens, mementoTokens, fabTokens, urlTokens, historyTokens, userPromptTokens] = await Promise.all([
          calculateTotalTokenLength(messages, tokenCalcOptions),
          calculateTotalTokenLength(mementoMessages, tokenCalcOptions),
          calculateTotalTokenLength(fabMessages, tokenCalcOptions),
          calculateTotalTokenLength(urlMessages, tokenCalcOptions),
          calculateTotalTokenLength(previousMessages, tokenCalcOptions),
          calculateTotalTokenLength([{ role: 'user' as const, content: effectiveUserPrompt }], tokenCalcOptions),
        ]);
        inputTokens = totalTokens;
        logger.info(
          `⏱️ [${Date.now() - processStartTime}ms] Token calculation completed (${inputTokens} input tokens) in ${
            Date.now() - tokenCalculationStartTime
          }ms`
        );
        const toolSchemaTokens = 0; // Will be populated in M4 with actual tool schema tokens

        // System prompts = remainder after subtracting all known sources from total.
        // This avoids double-counting (mementos/project are system-role but tracked separately)
        // and captures all other system content (dateTimeContext, toolPrompt, agentDetection, etc.)
        const knownSourceTokens =
          fabTokens + historyTokens + mementoTokens + urlTokens + userPromptTokens + toolSchemaTokens;
        const systemPromptTokens = Math.max(0, inputTokens - knownSourceTokens);

        tokensBySource = {
          systemPrompts: systemPromptTokens,
          conversationHistory: historyTokens,
          mementos: mementoTokens,
          fabFiles: fabTokens,
          urlContent: urlTokens,
          toolSchemas: toolSchemaTokens,
          userPrompt: userPromptTokens,
        };

        logger.info(`📊 Token breakdown by source calculated`, tokensBySource);
      } catch (tokenBreakdownError) {
        logger.warn(`📊 Failed to calculate token breakdown:`, tokenBreakdownError);
      }

      // Feed breakdown into telemetry builder for detailed system prompt tracking
      if (telemetryBuilder) {
        try {
          // Build system prompt details for telemetry
          type SystemPromptDetail = {
            source: 'hardcoded' | 'admin' | 'user' | 'project' | 'session' | 'org';
            name: string;
            tokenCount: number;
            wasIncluded: boolean;
          };
          const systemPromptDetails: SystemPromptDetail[] = [];

          // Date/time context (hardcoded)
          if (dateTimeContext) {
            const dtTokens = await calculateTotalTokenLength([dateTimeContext], tokenCalcOptions);
            systemPromptDetails.push({
              source: 'hardcoded',
              name: 'date_time_context',
              tokenCount: dtTokens,
              wasIncluded: true,
            });
          }

          // Tool prompt (admin/hardcoded)
          if (toolPromptMessage) {
            const toolTokens = await calculateTotalTokenLength([toolPromptMessage], tokenCalcOptions);
            systemPromptDetails.push({
              source: 'admin',
              name: 'tool_guidance',
              tokenCount: toolTokens,
              wasIncluded: true,
            });
          }

          // Agent detection prompts
          const agentMessages = featureContextMessages['agentDetection'] ?? [];
          if (agentMessages.length > 0) {
            const agentTokens = await calculateTotalTokenLength(agentMessages, tokenCalcOptions);
            systemPromptDetails.push({
              source: 'hardcoded',
              name: 'agent_detection',
              tokenCount: agentTokens,
              wasIncluded: true,
            });
          }

          // Quest master prompts
          const qmMessages = featureContextMessages['questMaster'] ?? [];
          if (qmMessages.length > 0) {
            const qmTokens = await calculateTotalTokenLength(qmMessages, tokenCalcOptions);
            systemPromptDetails.push({
              source: 'session',
              name: 'quest_master',
              tokenCount: qmTokens,
              wasIncluded: true,
            });
          }

          // Organization prompts
          const orgMessages = featureContextMessages['organizationPrompt'] ?? [];
          if (orgMessages.length > 0) {
            const orgTokens = await calculateTotalTokenLength(orgMessages, tokenCalcOptions);
            systemPromptDetails.push({
              source: 'org',
              name: 'organization_prompt',
              tokenCount: orgTokens,
              wasIncluded: true,
            });
          }

          // Session summary
          if (session.summary) {
            const summaryMsg = [
              { role: 'system' as const, content: `Previous conversation summary:\n${session.summary}` },
            ];
            const summaryTokens = await calculateTotalTokenLength(summaryMsg, tokenCalcOptions);
            systemPromptDetails.push({
              source: 'session',
              name: 'session_summary',
              tokenCount: summaryTokens,
              wasIncluded: true,
            });
          }

          // Project prompts
          const projectMessages = featureContextMessages['project'] ?? [];
          if (projectMessages.length > 0) {
            const projectTokens = await calculateTotalTokenLength(projectMessages, tokenCalcOptions);
            systemPromptDetails.push({
              source: 'project',
              name: 'project_context',
              tokenCount: projectTokens,
              wasIncluded: true,
            });
          }

          // Calculate total system prompt tokens
          const systemPromptTokensTotal = systemPromptDetails.reduce((sum, p) => sum + p.tokenCount, 0);

          telemetryBuilder.setSystemPrompts({
            prompts: systemPromptDetails,
            totalTokens: systemPromptTokensTotal,
            duplicateCount: quest.promptMeta?.context?.duplicateSystemPromptCount ?? 0,
          });

          if (tokensBySource) {
            telemetryBuilder.setTokensBySource(tokensBySource);
          }
        } catch (telemetryError) {
          logger.warn(`📊 [Telemetry] Failed to set system prompt details:`, telemetryError);
        }
      }

      // Save tokensBySource on the quest for all paths (overflow and success)
      if (tokensBySource) {
        quest.promptMeta!.context!.tokensBySource = tokensBySource;
      }

      // Detect and handle context overflow with detailed breakdown
      if (inputTokens > maxSafeInputTokens) {
        logger.error(`🚨 CRITICAL: Context overflow detected!`, {
          inputTokens,
          maxTokens: safeMaxTokens,
          contextLimit,
          maxSafeInputTokens,
          userId: this.user.id,
          sessionId,
          questId,
          model,
          mementoCount: (featureContextMessages['mementos'] ?? []).length,
          totalMessages: messages.length,
          tokenBreakdown: tokensBySource,
        });

        // Persist telemetry before throwing - the outer catch block's saveQuest() writes it to MongoDB
        if (telemetryBuilder) {
          telemetryBuilder.setContextWindow({
            inputTokens,
            outputTokens: 0,
            contextWindowLimit: contextLimit,
            utilizationPercentage: parseFloat(((inputTokens / contextLimit) * 100).toFixed(2)),
            reservedOutputTokens: safeMaxTokens,
            overflowDetected: true,
            overflowAmount: inputTokens - maxSafeInputTokens,
          });
          quest.promptMeta!.contextTelemetry = telemetryBuilder.build();
        }

        throw new Error(
          buildContextOverflowMessage({
            modelName: modelInfo.name || model,
            inputTokens,
            maxSafeInputTokens,
            tokensBySource,
            messageCount: messages.length,
            mementoCount: (featureContextMessages['mementos'] ?? []).length,
          })
        );
      }

      // Block disputed accounts regardless of credit enforcement setting -
      // disputePending is a fraud prevention gate, not a credit-accounting gate.
      if (this.user.disputePending) {
        throw new InsufficientCreditsError(
          'Your account is under review due to a payment dispute. Please contact support to resolve this.'
        );
      }

      if (adminSettingsEnforceCredits) {
        const creditValidationStartTime = Date.now();

        // Atomic pre-reservation: reserve estimated credits BEFORE streaming begins
        // This prevents race conditions where concurrent requests overdraw the balance.
        // Pattern: bare $inc + check + rollback (consistent with cliCompletions.ts)
        const usdCost = getTextModelCost(modelInfo, inputTokens, safeMaxTokens);
        const requiredCredits = usdToCredits(usdCost);

        // Determine credit holder (user or org)
        let reservationOwnerId = this.user.id;
        let reservationOwnerType = CreditHolderType.User;
        let reservationMethods: ICreditHolderMethods = this.db.users;
        const reservationUserCredits = organization ? organization.currentCredits : (this.user.currentCredits ?? 0);

        if (organization) {
          reservationOwnerId = organization.id;
          reservationOwnerType = CreditHolderType.Organization;
          reservationMethods = this.db.organizations;
        }

        // Preserve low-credits notification (checks current balance before reservation)
        if (reservationUserCredits < LOW_CREDIT_ALERT_THRESHOLD) {
          const { getNotificationDeduplicator } = await import('@bike4mind/utils');
          getNotificationDeduplicator()
            .handleLowCreditNotification(
              this.user.id,
              this.user.name || 'Unknown',
              this.user.email || 'No email',
              reservationUserCredits,
              organization ? { id: organization.id, name: organization.name } : null,
              this.slackWebhookUrl
            )
            .catch((error: Error) => {
              logger.error('Failed to send low credits notification:', error);
            });
        }

        const holderAfterReservation = await reservationMethods.incrementCredits(reservationOwnerId, -requiredCredits);

        if (!holderAfterReservation || holderAfterReservation.currentCredits < 0) {
          // Rollback immediately and reject
          await reservationMethods.incrementCredits(reservationOwnerId, requiredCredits);
          const actualBalance = (holderAfterReservation?.currentCredits ?? 0) + requiredCredits;
          const errorMessage = buildInsufficientCreditsMessage({
            available: actualBalance,
            required: requiredCredits,
            organizationName: organization?.name,
          });
          throw new InsufficientCreditsError(errorMessage, 'insufficient_credits');
        }

        // Update in-memory balance so mid-stream tool validation sees the reduced balance
        if (organization) {
          organization.currentCredits = holderAfterReservation.currentCredits;
        } else {
          this.user.currentCredits = holderAfterReservation.currentCredits;
        }

        // Notify if balance will drop below the alert threshold after reservation
        if (holderAfterReservation.currentCredits < LOW_CREDIT_ALERT_THRESHOLD) {
          const { getNotificationDeduplicator } = await import('@bike4mind/utils');
          getNotificationDeduplicator()
            .handleLowCreditNotification(
              this.user.id,
              this.user.name || 'Unknown',
              this.user.email || 'No email',
              holderAfterReservation.currentCredits,
              organization ? { id: organization.id, name: organization.name } : null,
              this.slackWebhookUrl
            )
            .catch((error: Error) => {
              logger.error('Failed to send low credits notification:', error);
            });
        }

        // Store reservation details for post-completion reconciliation
        this.reservedCredits = requiredCredits;
        this.reservedCreditsOwnerId = reservationOwnerId;
        this.reservedCreditsOwnerType = reservationOwnerType;
        this.reservedCreditHolder = holderAfterReservation;

        logger.info(
          `⏱️ [${Date.now() - processStartTime}ms] Credit pre-reservation completed in ${
            Date.now() - creditValidationStartTime
          }ms (reserved ${requiredCredits} credits, balance now ${holderAfterReservation.currentCredits})`
        );
      }

      quest.promptMeta!.context!.totalMessageCount = totalMessageCount;
      quest.promptMeta!.tokenUsage = {
        ...quest.promptMeta!.tokenUsage,
        inputTokens,
      };
      quest.promptMeta!.context!.mementoCount = (featureContextMessages['mementos'] ?? []).length;
      quest.promptMeta!.context!.attachedFiles = convertedFabFiles.map(file => ({
        name: file.fileName,
        type: file.mimeType,
        size: file.fileSize ?? 0,
      }));
      quest.promptMeta!.context!.messageHistoryLength = messages.length;
      quest.promptMeta!.prompt = message;
      quest.promptMeta!.questId = questId;
      quest.promptMeta!.performance ??= {};
      quest.promptMeta!.performance!.contextRetrievalTime = Date.now() - processStartTime;
      quest.reply = null;

      // Do NOT persist extraContextMessages CONTENT into promptMeta: the quest is serialized
      // to the client on many read paths (res.json({ quest }), chat history, WS), and for legacy
      // product-surface sessions extraContextMessages carries a server-owned proprietary prompt
      // - persisting it would leak the prompt to the client, the
      // same class of leak as systemPromptText. Nothing reads this
      // field back (verified repo-wide: the only reference was this write); the count below
      // preserves the debugging/tracking intent without the content.
      if (extraContextMessages.length > 0) {
        logger.debug(
          `📨 [EXTRA_CONTEXT] ${extraContextMessages.length} extra context messages (not persisted to promptMeta)`
        );
      }

      // Add system prompt tracking to promptMeta
      quest.promptMeta!.context!.sessionFileIds = sessionFabFileIds;
      quest.promptMeta!.context!.messageFileIds = messageFileIds;
      quest.promptMeta!.context!.globalSystemFileIds = globalSystemFileIds;
      quest.promptMeta!.context!.userSystemFileIds = enabledSystemFileIds;
      quest.promptMeta!.context!.dedupedSystemPrompts = dedupedFileIds;
      quest.promptMeta!.context!.totalSystemPromptCount = allFileIdsBeforeDedup.length;
      quest.promptMeta!.context!.duplicateSystemPromptCount = allFileIdsBeforeDedup.length - dedupedFileIds.length;

      // Track project system prompts separately
      const projectFileIds = featureContextMessages['project']
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          featureContextMessages['project'].map((msg: any) => msg.metadata?.fileId).filter(Boolean)
        : [];
      quest.promptMeta!.context!.projectSystemFileIds = projectFileIds;

      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] === CONTEXT RETRIEVAL PHASE COMPLETED in ${
          Date.now() - processStartTime
        }ms ===`
      );
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Completion setup completed in ${
          Date.now() - completionSetupStartTime
        }ms`
      );

      let stopSignalSent = false;
      const actualTokenUsage: Pick<
        CompletionInfo,
        'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
      > & { stopReason?: string } = {
        inputTokens: undefined,
        outputTokens: undefined,
        cacheReadInputTokens: undefined,
        cacheCreationInputTokens: undefined,
        stopReason: undefined,
      };

      if (THROTTLE_INTERVAL) {
        logger.info(`🚫 [STREAMING] Server throttling DISABLED for maximum TTFVT in ${process.env.NODE_ENV} mode`);
      } else {
        logger.info(`⏱️ [STREAMING] Server throttling enabled: ${THROTTLE_INTERVAL}ms interval`);
      }

      // Add timing logs
      const streamStartTime = Date.now();
      let chunkCount = 0;

      logger.info(`⏱️ [${Date.now() - processStartTime}ms] === LLM STREAMING PHASE START ===`);

      // Determine reasoning effort: user preference takes precedence over auto-classification
      // If user set 'auto' or null, use auto-classification from queryComplexity
      const userReasoningEffort = this.user.preferredReasoningEffort;
      const explicitReasoningEffort: ReasoningEffort | undefined =
        userReasoningEffort && userReasoningEffort !== 'auto' ? (userReasoningEffort as ReasoningEffort) : undefined;

      if (explicitReasoningEffort) {
        logger.info(`🧠 [ReasoningEffort] Using user preference: ${explicitReasoningEffort}`);
      } else {
        logger.info(`🧠 [ReasoningEffort] Using auto-classification from complexity: ${queryComplexity}`);
      }

      const options: Partial<ICompletionOptions> = {
        temperature: effectiveTemperature,
        topP,
        n: 1, // TODO: Force it to 1 for now. We need to reimplement how we handle multiple responses
        stream: modelInfo.can_stream && stream,
        maxTokens: safeMaxTokens,
        logitBias: logitBias ?? undefined,
        // Pass query complexity for auto-classification of reasoning effort
        complexity: queryComplexity as 'simple' | 'contextual' | 'complex',
        // Pass explicit user reasoning effort preference (if not 'auto')
        reasoningEffort: explicitReasoningEffort,
        thinking: thinking
          ? {
              enabled: thinking.enabled,
              budget_tokens: thinking.budget_tokens ?? 16000,
            }
          : undefined,
        tools: allTools,
      };

      // Check if Research Mode is enabled and handle parallel processing
      if (researchMode?.enabled && researchMode.configurations?.length > 0) {
        logger.info(
          `🔬 [Research Mode] Starting parallel processing with ${researchMode.configurations.length} configurations`
        );

        const researchModeService = new ResearchModeService(apiKeyTable, models, logger, this.user.id);

        // Handle Research Mode parallel processing
        const researchResults = await researchModeService.processResearchMode(
          researchMode,
          messages,
          options as ICompletionOptions,
          async (configId: string, streamedTexts: (string | null | undefined)[], completionInfo?: unknown) => {
            // Handle streaming for each configuration
            this.sendResearchModeStreamUpdate(quest, configId, streamedTexts, completionInfo);
          }
        );

        // Update quest with Research Mode results
        quest.researchModeResults = researchResults;
        quest.status = 'done';

        logger.info(`🔬 [Research Mode] Saving quest with results:`, {
          questId: quest.id,
          resultsCount: researchResults.length,
          results: researchResults.map(r => ({
            configId: r.configurationId,
            success: r.success,
            responseLength: r.response?.length || 0,
          })),
        });

        await saveQuest(quest);

        // Send final status update to complete the Research Mode processing
        await this.sendStatusUpdate(quest, null, { immediate: true });

        logger.info(`🔬 [Research Mode] Completed parallel processing`);

        return;
      }

      // Create an AbortController to allow cancelling the request
      const abortController = new AbortController();
      // Make the signal available to subagents via the closure captured by buildTools
      abortSignalHolder.signal = abortController.signal;

      // Store reference to the AbortController in a map using questId as key
      // This is used for actual request cancellation when a quest is stopped
      if (!this.abortControllers) {
        this.abortControllers = new Map();
      }
      this.abortControllers.set(questId, abortController);

      // Clean up the abort controller reference once completion is done
      const cleanupAbortController = () => {
        if (this.abortControllers && this.abortControllers.has(questId)) {
          this.abortControllers.delete(questId);
        }
      };

      // Set up a dedicated cancellation watcher that checks more frequently
      // than the regular status updates
      const startCancellationWatcher = () => {
        // Check for cancellation every 500ms
        cancelWatcherInterval = setInterval(async () => {
          try {
            // PERFORMANCE OPTIMIZATION: Use lightweight status check instead of full document fetch
            const latestQuestCheck = await this.db.quests.findByIdWithStatus(questId);
            if (latestQuestCheck?.status === 'stopped' && !stopSignalSent) {
              logger.info(`Cancellation watcher detected stopped quest ${questId}`);
              // If the quest is stopped, try to abort the underlying request
              if (this.abortControllers && this.abortControllers.has(questId)) {
                logger.info(`Aborting request for quest ${questId} via cancellation watcher`);
                this.abortControllers.get(questId)?.abort();
                cleanupAbortController();

                // Get full quest document for status update
                const fullQuest = await this.db.quests.findById(questId);
                if (fullQuest) {
                  await this.sendStatusUpdate(fullQuest, 'Generation cancelled by user', {
                    immediate: true,
                  });
                }
                stopSignalSent = true;

                // Clear this interval
                if (cancelWatcherInterval) {
                  clearInterval(cancelWatcherInterval);
                  cancelWatcherInterval = null;
                }
              }
            }
          } catch (error) {
            logger.warn(`Error in cancellation watcher for quest ${questId}:`, error);
          }
        }, 500);
      };

      // Start the cancellation watcher
      startCancellationWatcher();

      // (P2b) Resolve the overlapped rapid reply lookup before streaming begins - by now it
      // has run concurrently with all of context assembly, so this await is effectively free.
      rapidReplyResult = await rapidReplyPromise;
      logger.info(
        `🔍 [${Date.now() - processStartTime}ms] [RAPID REPLY] resolved (overlapped): ${rapidReplyResult ? 'FOUND' : 'none'}`
      );

      timer.phase('llm_completion');
      logger.info(`⏱️ [${Date.now() - processStartTime}ms] === LLM STREAMING PHASE START ===`);

      // Initialize fallback variables in proper scope
      let completionSuccess = false;
      let lastError: Error | null = null;
      let currentModel = modelInfo;
      let currentLlm = llm;
      let fallbackAttempt = 0;
      let overloadRetryCount = 0;
      let overloadRetriesExhausted = false;
      let toolPairingRetried = false;
      let requestTimeoutRetried = false;
      let streamIdleTimeoutRetried = false;

      // Rapid reply handoff: initialize handoff variables outside streaming callback
      let handOff = false;
      let transitionMode = 'replace';
      let rapidReplyContent = '';

      try {
        const modelInferenceStartTime = Date.now();

        // Max iterations: up to 3 overload retries + 1 fallback attempt + 1 initial = 5
        while (!completionSuccess && fallbackAttempt <= 1) {
          try {
            const isInitialAttempt = fallbackAttempt === 0;

            // Reset per attempt: the sticky field-wise merge below would otherwise
            // carry a failed attempt's counts (e.g. its cache reads) into the next
            // attempt's settlement - a billing bug now that provider usage is the
            // settlement basis, not audit data.
            actualTokenUsage.inputTokens = undefined;
            actualTokenUsage.outputTokens = undefined;
            actualTokenUsage.cacheReadInputTokens = undefined;
            actualTokenUsage.cacheCreationInputTokens = undefined;
            actualTokenUsage.stopReason = undefined;

            logger.info(
              `⏱️ [${Date.now() - processStartTime}ms] === ${
                isInitialAttempt ? 'STARTING' : `FALLBACK ATTEMPT ${fallbackAttempt}`
              } LLM COMPLETION === (${currentModel.id})`
            );

            if (!isInitialAttempt) {
              // Update quest metadata to reflect fallback attempt
              quest.promptMeta!.model!.name = currentModel.id;
              quest.promptMeta!.model!.backend = currentModel.backend;
              this.sendStatusUpdate(quest, `Trying alternative model: ${currentModel.id}...`, { statusAt: new Date() });
            }

            let toolsUsed: Array<{ name: string; arguments?: string; id?: string }> = [];

            // Get idle timeout settings for Anthropic streaming hang detection
            const enableIdleTimeout = getSettingsValue('EnableStreamIdleTimeout', defaultAdminSettings) === true;
            const idleTimeoutSeconds = Number(getSettingsValue('StreamIdleTimeoutSeconds', defaultAdminSettings)) || 90;

            // Diagnostic logging to verify streaming timeout feature flag status at runtime
            // Note: enableRequestTimeout uses the same flag as enableIdleTimeout since both
            // protect against a known Anthropic SDK streaming-hang bug
            logger.info('[LLM] Streaming timeout settings:', {
              enableIdleTimeout,
              enableRequestTimeout: enableIdleTimeout, // Uses same flag
              idleTimeoutSeconds,
              model: currentModel.id,
              isAnthropicModel: currentModel.backend === ModelBackend.Anthropic,
            });

            // Determine cache strategy (enable for multi-turn conversations with 2+ messages)
            const messageCount = messages.length;
            const hasTools = !!options.tools?.length;

            // Count message types for debugging
            const messageBreakdown = {
              system: messages.filter(m => m.role === 'system').length,
              user: messages.filter(m => m.role === 'user').length,
              assistant: messages.filter(m => m.role === 'assistant').length,
            };

            const cacheStrategy: ICacheStrategy = {
              enableCaching: messageCount >= 2, // Enable caching for multi-turn conversations
              cacheSystemPrompt: true, // Always cache system prompts
              cacheTools: hasTools, // Cache tools if present
              cacheConversationHistory: messageCount >= 2, // Cache history for multi-turn
              cacheTTL: '5m', // Use 5-minute TTL for active conversations
              conversationId: quest.id, // Use quest ID for xAI cache affinity
            };

            // Log cache strategy decision with structured metadata
            this.logger.info('[PromptCache] Strategy determined', {
              component: 'ChatCompletionProcess',
              enabled: cacheStrategy.enableCaching,
              messageCount,
              messageBreakdown,
              hasTools,
              toolCount: options.tools?.length || 0,
              model: currentModel.id,
              backend: currentModel.backend,
              cacheTTL: cacheStrategy.cacheTTL,
            });

            // Preview/E2E-only test affordance: provider/model fallback is a sustained-
            // outage safety net that can't be exercised without a real 5xx/throttle, so
            // there is no way for QA to verify it on a preview otherwise. When E2E
            // endpoints are enabled (production forces E2E off - see isE2EEnabled) AND the
            // prompt contains FORCE_FALLBACK_TEST_MARKER, simulate a sustained outage on the
            // primary backend so the real loop degrades to the equivalent model on another
            // path and renders the "Fallback Model Used" badge. Double-gated and
            // primary-attempt-only: a normal request can never trigger it, and the fallback
            // attempt still runs for real. The error mimics a Bedrock capacity outage
            // (ServiceUnavailableException) so it takes the real overloaded-error path:
            // same-model overload retries, then forceSwitch to the fallback model - matching
            // how a genuine sustained outage degrades. See the Guide for Testers.
            if (
              isInitialAttempt &&
              process.env.E2E_ENDPOINTS_ENABLED === 'true' &&
              JSON.stringify(messages).includes(FORCE_FALLBACK_TEST_MARKER)
            ) {
              const forced = new Error(
                `ServiceUnavailableException: simulated ${currentModel.backend} outage for fallback testing (preview only)`
              );
              forced.name = 'ServiceUnavailableException';
              throw forced;
            }

            await currentLlm.complete(
              currentModel.id,
              messages,
              {
                ...options,
                abortSignal: abortController.signal,
                cacheStrategy,
                _internal: {
                  ...options._internal,
                  enableIdleTimeout,
                  enableRequestTimeout: enableIdleTimeout,
                  idleTimeoutMs: idleTimeoutSeconds * 1000,
                  // Cap tool-call rounds via the generic `maxToolCalls` session field
                  // (strips tools after N rounds so an eager model can't keep re-emitting
                  // capped search/retrieve calls). Set by product surfaces at session
                  // create; the legacy product-flag fallback was retired in M0.5.
                  ...(session.maxToolCalls != null ? { maxToolCalls: session.maxToolCalls } : {}),
                },
              },
              async (streamedTexts, completionInfo) => {
                toolsUsed = completionInfo?.toolsUsed || [];
                // Include tool ID for Anthropic API tool pairing reconstruction
                quest.promptMeta!.functionCalls = toolsUsed.map(tool => {
                  let parameters: Record<string, unknown> = {};
                  try {
                    parameters = JSON.parse(tool.arguments || '{}');
                  } catch (e) {
                    logger.warn('[ChatCompletionProcess] Skipping malformed tool arguments in functionCalls (#9328)', {
                      toolName: tool.name,
                      argumentsPreview: (tool.arguments || '').substring(0, 100),
                      error: e instanceof Error ? e.message : String(e),
                    });
                  }
                  return { name: tool.name, parameters, id: tool.id };
                });
                // Clear the interval on first response and calculate TTFVT
                if (streamedTexts.some(text => text != null && text.trim().length > 0)) {
                  // Capture TTFVT on first non-empty chunk (regardless of chunk number)
                  if (!quest.promptMeta!.performance!.firstTokenTime) {
                    const timeToFirstChunk = Date.now() - streamStartTime;
                    const ttfvt = Date.now() - processStartTime; // Time to First Visible Token
                    quest.promptMeta!.performance!.firstTokenTime = ttfvt;
                    this.sendStatusUpdate(quest, 'First model response', { statusAt: new Date(), silent: true });

                    logger.info(`⏱️ [${Date.now() - processStartTime}ms] Time to first chunk: ${timeToFirstChunk}ms`);
                    logger.info(
                      `🔍 [DEBUG] First content chunk: ${JSON.stringify(streamedTexts.slice(0, 2))} (Model: ${
                        currentModel.id
                      })`
                    );
                  }
                } else if (chunkCount === 0 && streamedTexts.some(text => text != null)) {
                  // Some models might send empty or whitespace-only first chunks
                  logger.info(
                    `⚠️ [DEBUG] Empty first chunk received for ${currentModel.id}: ${JSON.stringify(
                      streamedTexts.slice(0, 2)
                    )}`
                  );
                }

                chunkCount++;

                // PERFORMANCE OPTIMIZATION: Removed redundant database query on every chunk!
                // The cancellation watcher (running every 500ms) already handles quest status checking
                // with optimized findByIdWithStatus. This saves 750-1500ms of database overhead.

                // Check if stop signal was already sent by cancellation watcher
                if (stopSignalSent) {
                  logger.info(
                    `🛑 [${Date.now() - processStartTime}ms] Generation cancelled by user (attempt ${fallbackAttempt})`
                  );
                  return;
                }

                // Handle rapid reply transition when main quest starts
                // Check if rapid reply content exists (regardless of active state since rapid reply finishes first)
                if (
                  rapidReplyResult &&
                  rapidReplyResult.rapidResponse.content.length > 0 &&
                  rapidReplyResult.status === 'success' &&
                  handOff === false
                ) {
                  // hand off
                  rapidReplyContent = rapidReplyResult.rapidResponse.content;
                  handOff = true;
                  logger.info(` 🔍 🔍 🔍 🔍 🔍 🔍  AFTER HANDOFF OPERATIONS 🔍 🔍 🔍 🔍 🔍 🔍 `);

                  // Get transition mode from rapid reply settings
                  const rapidReplySettings = await this.db.rapidReply?.settings.getSettings();
                  transitionMode = rapidReplySettings?.transitionMode || 'replace';

                  logger.info(
                    `🔍 [TRANSITION_DEBUG] Query complexity: ${queryComplexity}, Transition mode: ${transitionMode}, Rapid reply content: "${rapidReplyContent}"`
                  );

                  // Handle transition based on mode
                  if (transitionMode === 'replace') {
                    // Replace mode: Clear rapid reply content and start fresh
                    logger.info(`🔄 [TRANSITION] Replace mode - clearing rapid reply content`);
                    quest.replies = [];
                    quest.reply = '';
                  } else if (transitionMode === 'append') {
                    // Append mode: initialize replies[0] with rapid reply content + space for separation
                    const rapidContentWithSpace = rapidReplyContent + ' ';
                    replies[0] = rapidContentWithSpace;
                    quest.reply = rapidContentWithSpace;
                    quest.replies = [rapidContentWithSpace];
                    logger.info(`🔄 [APPEND] replies[0] after setting: "${replies[0]}"`);
                  } else {
                    logger.info(`🔄 [DEBUG] Unknown transition mode: ${transitionMode}`);
                  }
                  // Note: 'enhance' mode would be more complex and could be implemented later
                }

                await Promise.all(
                  streamedTexts.map(async (text, index) => {
                    if (!text) return;

                    // In append mode, always append to replies[0] regardless of stream index
                    if (transitionMode === 'append') {
                      replies[0] ??= '';
                      replies[0] += text;
                    } else {
                      replies[index] ??= '';
                      // If the last character is </think> which indicates the end of a thinking reply, append the text to the next reply
                      // This happens when thinking models use other tools which causes the index to reset.
                      if (replies[index].endsWith('</think>')) {
                        replies[index + 1] ??= '';
                        replies[index + 1] += text;
                      } else {
                        replies[index] += text;
                      }
                    }
                    quest.replies = Object.values(replies);
                    // Send message to the client for each received streamed message
                    smartSend();
                  })
                );
                // Field-wise assign-not-clobber (mirrors cliCompletions.ts:211-214). Some
                // adapters fire intermediate callbacks carrying only {toolsUsed} or with
                // inputTokens: 0 (see anthropicBackend.ts:1598-1604) before the terminal
                // turn reports the accumulated total. A whole-object replace would wipe
                // earlier counts if a future adapter ever emitted a tail callback without
                // usage. != null guard keeps legitimate 0 values from being lost.
                if (completionInfo?.inputTokens != null) actualTokenUsage.inputTokens = completionInfo.inputTokens;
                if (completionInfo?.outputTokens != null) actualTokenUsage.outputTokens = completionInfo.outputTokens;
                if (completionInfo?.cacheReadInputTokens != null)
                  actualTokenUsage.cacheReadInputTokens = completionInfo.cacheReadInputTokens;
                if (completionInfo?.cacheCreationInputTokens != null)
                  actualTokenUsage.cacheCreationInputTokens = completionInfo.cacheCreationInputTokens;
                // stopReason follows the same preserve-last-non-null contract as token
                // counts. Previously this field was overwritten by every callback (via
                // the whole-object replace), so a tail callback emitting undefined would
                // clobber a real value. Only the telemetry consumer at line ~3080 reads
                // this, and it benefits from sticky last-known semantics.
                if (completionInfo?.stopReason != null) actualTokenUsage.stopReason = completionInfo.stopReason;
              }
            );
            // Completion succeeded
            completionSuccess = true;
            logger.info(
              `✅ [${Date.now() - processStartTime}ms] LLM completion succeeded with ${
                currentModel.id
              } (attempt ${fallbackAttempt})`
            );
          } catch (attemptError) {
            lastError = attemptError as Error;
            // Aborts (user cancel, client disconnect, or request/idle timeout) are
            // benign - log the raw error at warn so its stack stays out of the
            // CloudWatch ERROR to LiveOps/Slack alerts. This bare dump was
            // the last error-severity log on the abort path; the backends and the
            // formatted summary below were already downgraded. Real failures still dump
            // at error with the full stack.
            if (isAbortError(lastError)) {
              logger.warn(lastError);
            } else {
              logger.error(lastError);
            }
            const isRetryableError = shouldTriggerFallback(lastError);

            logger.warn(
              `❌ [${Date.now() - processStartTime}ms] LLM completion failed with ${
                currentModel.id
              } (attempt ${fallbackAttempt}):`,
              {
                error: lastError.message,
                shouldRetry: isRetryableError,
              }
            );

            // Tool pairing recovery: if this is a tool_use/tool_result pairing error,
            // strip all tool blocks from history and retry with the same model
            if (isToolPairingError(lastError) && !toolPairingRetried) {
              toolPairingRetried = true;
              logger.warn(
                `🔧 [Tool Pairing Recovery] Detected tool pairing error, stripping tool blocks from history and retrying`
              );
              messages = stripAllToolBlocks(messages, logger);

              // Reset streaming state for clean retry
              for (const key of Object.keys(replies)) {
                replies[parseInt(key)] = '';
              }
              quest.replies = [];
              chunkCount = 0;

              continue; // Retry the while loop with cleaned messages
            }

            // If this is not a retryable error, re-throw immediately
            if (!isRetryableError) {
              logger.warn(`🚫 [Fallback] Non-retryable error, failing immediately`);
              throw lastError;
            }

            // Same-model retry: for overloaded errors, retry with exponential backoff
            // before falling back to a different model (transient outages often resolve quickly)
            if (isOverloadedError(lastError) && fallbackAttempt === 0) {
              const MAX_OVERLOAD_RETRIES = 3;
              const BASE_DELAY_MS = 2000;
              overloadRetryCount++;

              if (overloadRetryCount <= MAX_OVERLOAD_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, overloadRetryCount - 1);
                const jitter = Math.floor(Math.random() * delay * 0.25);
                const totalDelay = delay + jitter;

                logger.info(
                  `🔄 [Overload Retry] ${currentModel.id} overloaded, retrying in ${totalDelay}ms (attempt ${overloadRetryCount}/${MAX_OVERLOAD_RETRIES})`
                );

                this.sendStatusUpdate(
                  quest,
                  `AI service is busy, retrying... (attempt ${overloadRetryCount}/${MAX_OVERLOAD_RETRIES})`,
                  { statusAt: new Date() }
                );

                await new Promise(resolve => setTimeout(resolve, totalDelay));

                // Reset streaming state for clean retry
                for (const key of Object.keys(replies)) {
                  replies[parseInt(key)] = '';
                }
                quest.replies = [];
                chunkCount = 0;

                continue; // Re-enter the while loop to retry with the same model
              }

              logger.warn(`🚫 [Overload Retry] All ${MAX_OVERLOAD_RETRIES} retries exhausted for ${currentModel.id}`);
              overloadRetriesExhausted = true;
            }

            // Timeout retry: for request timeouts (pre-streaming), retry once with short backoff
            // then fall back quickly. Unlike overloaded (3 retries), timeouts indicate the model
            // may not respond at all - one retry covers transient blips, then bail to fallback.
            if (isRequestTimeoutError(lastError) && !requestTimeoutRetried) {
              requestTimeoutRetried = true;
              const TIMEOUT_RETRY_DELAY_MS = 2000;
              const jitter = Math.floor(Math.random() * 500);

              logger.info(
                `🔄 [Timeout Retry] ${currentModel.id} request timeout, retrying once in ${TIMEOUT_RETRY_DELAY_MS + jitter}ms`
              );

              this.sendStatusUpdate(quest, 'AI service is slow, retrying...', { statusAt: new Date() });

              await new Promise(resolve => setTimeout(resolve, TIMEOUT_RETRY_DELAY_MS + jitter));

              // Reset streaming state for clean retry
              for (const key of Object.keys(replies)) {
                replies[parseInt(key)] = '';
              }
              quest.replies = [];
              chunkCount = 0;

              continue;
            }

            // Stream idle timeout retry: for mid-stream stalls, retry once with short backoff.
            // Unlike request timeouts (model never started), stream idle timeouts mean the model
            // started responding but stalled - likely transient overload. One retry before fallback.
            if (isStreamIdleTimeoutError(lastError) && !streamIdleTimeoutRetried) {
              streamIdleTimeoutRetried = true;
              const STREAM_IDLE_RETRY_DELAY_MS = 3000;
              const jitter = Math.floor(Math.random() * 1000);

              logger.info(
                `🔄 [Stream Idle Retry] ${currentModel.id} stream stalled mid-response, retrying once in ${STREAM_IDLE_RETRY_DELAY_MS + jitter}ms`
              );

              this.sendStatusUpdate(quest, 'AI service is slow, retrying...', { statusAt: new Date() });

              await new Promise(resolve => setTimeout(resolve, STREAM_IDLE_RETRY_DELAY_MS + jitter));

              // Reset streaming state for clean retry
              for (const key of Object.keys(replies)) {
                replies[parseInt(key)] = '';
              }
              quest.replies = [];
              chunkCount = 0;

              continue;
            }

            // If we've already tried fallback, throw the last error
            if (fallbackAttempt >= 1) {
              logger.warn(`🚫 [Fallback] Fallback attempt already tried, no more attempts`);
              throw lastError;
            }

            // Fallback: try to get a fallback model
            try {
              // Extract fallback model ID from request
              const fallbackModelId = body.fallbackModel;

              const originalModel = currentModel; // Store original model before fallback
              const fallbackResult = await getLlmWithFallback(
                currentModel,
                fallbackModelId,
                models,
                apiKeyTable,
                logger,
                { forceSwitch: overloadRetriesExhausted }
              );

              if (!fallbackResult || fallbackResult.attempt === 0) {
                // No fallback available or we got the same model back
                logger.warn(`🚫 [Fallback] No suitable fallback model available`);
                throw lastError;
              }

              // Update to the fallback model
              currentModel = fallbackResult.model;
              currentLlm = fallbackResult.backend;
              fallbackAttempt++;

              logger.info(`🔄 [Fallback] Switching to fallback model: ${currentModel.id} (attempt ${fallbackAttempt})`);

              // Store fallback info in quest data for consistent streaming delivery
              const fallbackInfo = {
                sessionId,
                primaryModel: originalModel.id,
                primaryModelName: originalModel.name,
                fallbackModel: currentModel.id,
                fallbackModelName: currentModel.name,
                timestamp: Date.now(),
              };

              // Store fallback info in quest so it's included in all streamed_chat_completion messages
              quest.fallbackInfo = fallbackInfo;

              // Track fallback in telemetry
              if (telemetryBuilder) {
                try {
                  const fallbackReasonText = lastError instanceof Error ? lastError.message : 'Unknown error';
                  telemetryBuilder.setFallback(true, fallbackReasonText);
                  telemetryBuilder.setActualModel(currentModel.id);
                  logger.info(`📊 [Telemetry] Recorded fallback: ${originalModel.id} → ${currentModel.id}`);
                } catch (telemetryError) {
                  logger.warn(`📊 [Telemetry] Failed to record fallback:`, telemetryError);
                }
              }

              logger.info(
                `📤 [Fallback] Added fallback info to quest data for consistent streaming: ${fallbackInfo.primaryModel} → ${fallbackInfo.fallbackModel}`
              );

              this.sendStatusUpdate(quest, `Trying alternative model: ${currentModel.id}...`, { statusAt: new Date() });

              // Clear previous replies for retry
              Object.keys(replies).forEach(key => {
                replies[parseInt(key)] = '';
              });
              quest.replies = [];

              // Reset streaming state for retry
              chunkCount = 0;
              // Continue the loop with the new model
              continue;
            } catch (fallbackError) {
              logger.warn(`🚫 [Fallback] Failed to get fallback model:`, fallbackError);
              throw lastError;
            }
          }
        }

        // If we reach here without success, throw the last error
        if (!completionSuccess) {
          throw lastError || new Error('LLM completion failed without specific error');
        }

        // Clean up the abort controller and intervals
        cleanupAbortController();
        if (cancelWatcherInterval) {
          clearInterval(cancelWatcherInterval);
          cancelWatcherInterval = null;
        }

        // Mark quest as done when all the replies are received
        quest.status = 'done';

        const modelInferenceTime = Date.now() - modelInferenceStartTime;
        quest.promptMeta!.performance!.modelInferenceTime = modelInferenceTime;

        // Log TTFVT measurement result
        if (quest.promptMeta!.performance!.firstTokenTime) {
          logger.info(
            `✅ [TTFVT] Successfully measured: ${quest.promptMeta!.performance!.firstTokenTime}ms for ${
              currentModel.id
            } ${fallbackAttempt > 0 ? `(fallback attempt ${fallbackAttempt})` : ''}`
          );

          // Update rapid reply result with actual TTFVT savings now that main quest is complete
          if (this.db.rapidReply?.results?.updateResult) {
            try {
              const mainQuestTtfvt = quest.promptMeta!.performance!.firstTokenTime;

              if (rapidReplyResult && rapidReplyResult.rapidResponse.ttfvt) {
                const actualTtfvtSavings = mainQuestTtfvt - rapidReplyResult.rapidResponse.ttfvt;

                // Get the current metrics and add ttfvtSavings
                const currentMetrics = rapidReplyResult.metrics || {};
                const updatedMetrics = {
                  ...currentMetrics,
                  ttfvtSavings: actualTtfvtSavings,
                };

                const updateData = {
                  $set: {
                    metrics: updatedMetrics,
                    questId: questId,
                  },
                };
                this.db.rapidReply.results.updateResult(rapidReplyResult.id, updateData);
              } else {
                logger.debug(`ℹ️ [TTFVT] No rapid reply result found for quest ${questId} or no rapid TTFVT recorded`);
              }
            } catch (error) {
              logger.error(`❌ [TTFVT] Failed to update rapid reply result:`, error);
            }
          }
        } else if (chunkCount > 0) {
          logger.warn(
            `⚠️ [TTFVT] Failed to capture first token time for ${currentModel.id} despite ${chunkCount} chunks - all chunks were empty`
          );
        } else {
          logger.warn(
            `⚠️ [TTFVT] No streaming chunks received for ${currentModel.id} - possible non-streaming response`
          );
        }

        logger.info(
          `⏱️ [${Date.now() - processStartTime}ms] === LLM COMPLETION FINISHED in ${modelInferenceTime}ms ===`
        );

        timer.phase('post_process');

        // Process artifacts if enabled
        if (getSettingsValue('EnableArtifacts', defaultAdminSettings)) {
          const { parseArtifacts, convertCodeBlocksToArtifacts } = await import('@bike4mind/utils');
          const artifactProcessingStartTime = Date.now();

          quest.replies = quest.replies?.map(reply => {
            const processedReply = convertCodeBlocksToArtifacts(reply);
            const { artifacts } = parseArtifacts(processedReply);

            if (artifacts.length > 0) {
              logger.info(`Found ${artifacts.length} artifacts in response`);
              if (quest.promptMeta) {
                // Preserve tool-extracted artifacts (source: 'tool_result') - they contain
                // deterministic output and rich metadata. Only add LLM text artifacts for
                // types that weren't already extracted from tool results.
                // Build a set of internal artifact types (e.g. 'chess', 'react') that were
                // already extracted from tool results. parseArtifacts() returns internal types
                // (like 'chess'), not MIME types (like 'application/vnd.ant.chess'), so we must
                // compare using the same representation.
                const toolInternalTypes = new Set(
                  (quest.promptMeta.artifacts || [])
                    .filter(a => a.metadata && (a.metadata as Record<string, unknown>).source === 'tool_result')
                    .map(a => {
                      // Map MIME type back to internal type via the shared single-source mapper
                      // (this previously inlined the switch, which let lattice's
                      // b4m-namespaced MIME dodge the dedup set). Fall back to raw MIME.
                      const mime = (a.metadata as Record<string, unknown>).artifactType as string;
                      return mapMimeTypeToArtifactType(mime) ?? mime;
                    })
                );

                const textArtifacts = artifacts
                  .filter(artifact => {
                    // Skip LLM text artifacts whose internal type was already captured from the tool
                    if (toolInternalTypes.has(artifact.type)) {
                      logger.debug(
                        `Skipping LLM text artifact (type=${artifact.type}) — already extracted from tool result`
                      );
                      return false;
                    }
                    return true;
                  })
                  .map(artifact => ({
                    type: artifact.type as 'text' | 'image' | 'file' | 'data',
                    content: artifact.content,
                    metadata: {},
                    timestamp: new Date(),
                  }));

                // Merge: keep tool artifacts, add non-duplicate text artifacts
                quest.promptMeta.artifacts = [...(quest.promptMeta.artifacts || []), ...textArtifacts];
              }
            }

            return processedReply;
          });

          // Capture actual artifact processing duration
          actualArtifactProcessingDuration = Date.now() - artifactProcessingStartTime;

          // Update execution tracking with artifact processing
          quest.promptMeta!.executionTracking = {
            ...quest.promptMeta!.executionTracking,
            steps: [
              ...(quest.promptMeta!.executionTracking?.steps || []),
              {
                name: 'artifact_processing',
                status: 'completed',
                startTime: new Date(artifactProcessingStartTime),
                endTime: new Date(),
              },
            ],
            completedSteps: [...(quest.promptMeta!.executionTracking?.completedSteps || []), 'artifact_processing'],
          };

          // Update feature execution times
          quest.promptMeta!.performance!.featureExecutionTimes = {
            ...quest.promptMeta!.performance!.featureExecutionTimes,
            artifactProcessing: Date.now() - artifactProcessingStartTime,
          };
        }

        // Update the streaming performance metrics
        const totalStreamTime = Date.now() - streamStartTime;
        const totalChars = Object.values(replies).reduce((sum, reply) => sum + reply.length, 0);
        const charsPerSecond = totalStreamTime > 0 ? totalChars / (totalStreamTime / 1000) : 0;

        quest.promptMeta!.performance!.streamingPerformance = {
          chunkCount,
          totalStreamTime,
          totalChars,
          charsPerSecond: Math.round(charsPerSecond),
        };
      } catch (error) {
        logger.debug(`Error during fallback-enabled model invocation (final model: ${currentModel.id}):`, error);
        throw error; // Re-throw the error to be handled by the outer try-catch
      }

      // Post-streaming processing: token counting, credits, performance metrics, features.
      // Wrapped in protective try/catch so failures here never overwrite quest.reply or leave quest stuck.
      try {
        // Calculate output tokens
        const outputTokenCalculationStartTime = Date.now();
        const outputTokens = await this.tokenizer.countTokens(Object.values(replies), currentModel.id);
        logger.info(
          `⏱️ [${Date.now() - processStartTime}ms] Output token calculation completed (${outputTokens} tokens) in ${
            Date.now() - outputTokenCalculationStartTime
          }ms`
        );

        if (this.verbose) {
          logger.log('\n📈 Token Usage:');
          logger.log(`• Input Tokens: ${actualTokenUsage?.inputTokens?.toLocaleString() ?? 'N/A'}`);
          logger.log(`• Output Tokens: ${actualTokenUsage?.outputTokens?.toLocaleString() ?? 'N/A'}`);
          logger.log(
            `• Total Tokens: ${(
              (actualTokenUsage?.inputTokens ?? 0) + (actualTokenUsage?.outputTokens ?? 0)
            ).toLocaleString()}`
          );
        }

        // Settlement basis: provider-reported usage when present, the true COGS
        // basis matching the cliCompletions path - all four components (input,
        // output, cache read, cache creation) at their per-model rates. Both
        // counts must be strictly positive: adapters coerce missing usage to 0
        // (DeepSeek and Llama-Bedrock streaming never populate it), so a zero
        // basis means "provider reported nothing", not "the call was free".
        // Deliberately including the output axis: a report with real input but
        // zero output falls back to the local estimate rather than billing the
        // zeroed axis as free.
        // Anything less than full positive usage falls back to the local
        // estimate, which also remains the pre-reservation basis. The fallback
        // keeps the capped cache-read discount and never bills cache creation,
        // exactly the pre-provider-basis behavior. The bases never blend.
        //
        // Disjoint-fields assumption: cacheReadInputTokens is only forwarded by
        // Anthropic-family adapters - the direct Anthropic adapter and
        // Claude-on-Bedrock (bedrockBackend/base.ts) - whose input_tokens EXCLUDE
        // cached tokens. OpenAI/Gemini/xAI report prompt tokens INCLUSIVE of cache
        // and must not forward cache counts here without also subtracting them
        // from input.
        //
        // NOTE: the provider input (uncached tail) drives getTextModelCost's
        // pricing-tier selection. Every model today publishes a single tier, so
        // this is exact; if tiered pricing lands, a heavily-cached prompt could
        // select a cheaper tier for its cache volume - revisit tier selection then.
        const hasProviderUsage = (actualTokenUsage?.inputTokens ?? 0) > 0 && (actualTokenUsage?.outputTokens ?? 0) > 0;
        const settledBasis = hasProviderUsage ? ('provider' as const) : ('local' as const);
        const settledInputTokens = hasProviderUsage ? actualTokenUsage.inputTokens! : inputTokens;
        const settledOutputTokens = hasProviderUsage ? actualTokenUsage.outputTokens! : outputTokens;
        const cacheReadInputTokens = hasProviderUsage
          ? (actualTokenUsage.cacheReadInputTokens ?? 0)
          : Math.min(actualTokenUsage?.cacheReadInputTokens ?? 0, inputTokens);
        const estimatedCost = hasProviderUsage
          ? getTextModelCost(
              currentModel,
              settledInputTokens,
              settledOutputTokens,
              cacheReadInputTokens,
              actualTokenUsage.cacheCreationInputTokens ?? 0
            )
          : getTextModelCost(
              currentModel,
              inputTokens - cacheReadInputTokens * (1 - CACHE_READ_MULTIPLIER),
              outputTokens
            );
        // Single stochastic settlement draw, shared by the quest meta, the
        // usage event, and the ledger deduction below so they can never
        // disagree about what was charged.
        const textCreditsUsed = usdToCreditsStochastic(estimatedCost);
        quest.promptMeta!.tokenUsage = {
          ...quest.promptMeta!.tokenUsage,
          // Local-estimate counts stay in outputTokens/totalTokens (comparable
          // across all rows); provider counts stay in actual*; settledBasis says
          // which of the two priced this row.
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          actualInputTokens: actualTokenUsage?.inputTokens,
          actualOutputTokens: actualTokenUsage?.outputTokens,
          cacheReadInputTokens: cacheReadInputTokens > 0 ? cacheReadInputTokens : undefined,
          settledBasis,
          estimatedCost,
          creditsUsed: textCreditsUsed,
        };

        // Drift detection: log when our tokenizer diverges substantially from what
        // the provider reports. With provider-basis settlement this no longer
        // guards billing; it monitors the quality of the local estimate that still
        // drives pre-reservation (and fallback settlement). Causes worth
        // investigating: a new content-block shape we don't measure, tool schemas
        // (toolSchemaTokens TODO at the breakdown site), a provider accounting
        // change. Threshold is symmetric +/-30%.
        // Compare against the provider's FULL input accounting, not just the uncached tail.
        // Provider `input_tokens` reports only the tokens NOT served from / written to cache;
        // on a prompt-cache hit or write the rest lands in cache_read/cache_creation. Summing
        // all three keeps the ratio ~1 during routine cache activity, so [BILLING_DRIFT] stays
        // a signal for real tokenizer divergence instead of tripping on every warm cache read
        // (which would otherwise blow past the threshold, e.g. 3041 / 2).
        const apiInputForDrift =
          actualTokenUsage?.inputTokens != null
            ? actualTokenUsage.inputTokens +
              (actualTokenUsage.cacheReadInputTokens ?? 0) +
              (actualTokenUsage.cacheCreationInputTokens ?? 0)
            : undefined;
        if (apiInputForDrift != null && apiInputForDrift > 0) {
          const ratio = inputTokens / apiInputForDrift;
          if (ratio < 0.7 || ratio > 1.3) {
            logger.warn('[BILLING_DRIFT] Local vs provider input-token count diverges', {
              questId: quest.id,
              userId: this.user.id,
              sessionId: quest.sessionId,
              model: currentModel.id,
              backend: currentModel.backend,
              localInputTokens: inputTokens,
              providerInputTokens: apiInputForDrift,
              ratio: Number(ratio.toFixed(2)),
              tokensBySource: quest.promptMeta?.context?.tokensBySource,
            });
          }
        }
        // Update functionCalls with creditsUsed
        quest.promptMeta!.functionCalls = (quest.promptMeta!.functionCalls || []).map(fc => {
          if (this.toolCreditsMap.has(fc.name || '')) {
            return { ...fc, creditsUsed: this.toolCreditsMap.get(fc.name || '') };
          }
          return fc;
        });

        // Update execution tracking
        quest.promptMeta!.executionTracking = {
          ...quest.promptMeta!.executionTracking,
          steps: [
            {
              name: 'initialization',
              status: 'completed',
              startTime: new Date(processStartTime),
              endTime: new Date(),
            },
            {
              name: 'model_inference',
              status: 'completed',
              startTime: new Date(), // Fallback to now
              endTime: new Date(),
            },
            {
              name: 'artifact_processing',
              status: 'completed',
              startTime: new Date(), // Fallback to now
              endTime: new Date(),
            },
          ],
          completedSteps: ['initialization', 'model_inference', 'artifact_processing'],
        };

        // Calculate actual individual durations for each phase
        const abilityDuration = essentialDataStartTime - abilityStartTime;
        const essentialDataDuration = modelSetupStartTime - essentialDataStartTime;
        const modelSetupDuration = historyStartTime - modelSetupStartTime;
        const historyDuration = completionSetupStartTime - historyStartTime;
        const artifactDuration = actualArtifactProcessingDuration; // Actual measured duration
        const onCompleteDuration = actualOnCompleteDuration; // Actual measured duration

        // Update feature execution times (using Map to match Mongoose schema)
        quest.promptMeta!.performance!.featureExecutionTimes = new Map([
          ['abilitySetup', Math.max(0, abilityDuration)], // Individual duration
          ['essentialDataFetch', Math.max(0, essentialDataDuration)], // Individual duration
          ['modelSetup', Math.max(0, modelSetupDuration)], // Individual duration
          ['historyLoading', Math.max(0, historyDuration)], // Individual duration
          ['artifactProcessing', Math.max(0, artifactDuration)], // Individual duration
          ['onCompleteFeatures', onCompleteDuration], // Approximate duration
        ]);

        // Database operations - use actual measurements where available
        quest.promptMeta!.performance!.databaseOperationTimes = new Map([
          ['initialQuestSave', 45], // Initial quest creation (estimated)
          ['finalQuestSave', actualFinalSaveDuration], // Actual measured duration
          ['organizationUpdate', 35], // Organization updates (estimated)
        ]);

        logger.info(
          `🔍 [DEBUG] Individual feature durations: ability=${abilityDuration}ms, data=${essentialDataDuration}ms, model=${modelSetupDuration}ms, history=${historyDuration}ms, artifact=${artifactDuration}ms, onComplete=${onCompleteDuration}ms`
        );

        // P6: Credits reconciliation - settle the pre-reserved credits against actual usage.
        // The balance was already adjusted atomically at pre-reservation time; this step
        // handles the delta and records audit-trail transactions.
        if (adminSettingsEnforceCredits) {
          if (!this.db.creditTransactions) {
            throw new BadRequestError('Enforce credits is enabled but credit transactions are not available');
          }
          const toolCreditsUsed = (quest.promptMeta!.functionCalls || []).reduce(
            (sum, fc) => sum + (fc.creditsUsed || 0),
            0
          );
          const totalCreditsUsed = textCreditsUsed + toolCreditsUsed;
          quest.creditsUsed = totalCreditsUsed;

          // Clamp computed BEFORE the usage event so the event can carry the
          // written-off portion; summing creditsCharged alone would over-count
          // collected revenue whenever the clamp fires.
          const { delta: settlementDelta, writtenOffCredits } = this.reservedCreditsOwnerId
            ? computeSettlementDelta(
                this.reservedCredits,
                totalCreditsUsed,
                this.reservedCreditHolder?.currentCredits ?? 0
              )
            : { delta: this.reservedCredits - totalCreditsUsed, writtenOffCredits: 0 };
          if (writtenOffCredits > 0) {
            logger.warn('[BILLING_SHORTFALL_CLAMP] Settlement exceeds balance; flooring at zero', {
              questId: quest.id,
              ownerId: this.reservedCreditsOwnerId,
              ownerType: this.reservedCreditsOwnerType,
              shortfall: totalCreditsUsed - this.reservedCredits,
              available: Math.max(0, this.reservedCreditHolder?.currentCredits ?? 0),
              writtenOff: writtenOffCredits,
            });
          }

          // Dual-write usage event: ties frozen COGS to credits debited
          // for margin reporting. Fire-and-forget - must never affect billing.
          this.db.usageEvents
            ?.record({
              requestId: quest.id,
              userId: this.user.id,
              ownerId: this.reservedCreditsOwnerId || this.user.id,
              ownerType: this.reservedCreditsOwnerType,
              sessionId: quest.sessionId,
              feature: 'chat',
              provider: currentModel.backend,
              model: currentModel.id,
              // inputTokens/outputTokens are ALWAYS the local estimate and the
              // provider* fields ALWAYS the provider counts, so drift and invoice
              // reconciliation stay comparable across rows; settledBasis says
              // which basis priced costUsd/creditsCharged.
              inputTokens,
              outputTokens,
              settledBasis,
              cachedInputTokens: cacheReadInputTokens,
              cacheWriteTokens: actualTokenUsage?.cacheCreationInputTokens ?? 0,
              providerInputTokens: actualTokenUsage?.inputTokens,
              providerOutputTokens: actualTokenUsage?.outputTokens,
              costUsd: estimatedCost,
              creditsCharged: textCreditsUsed,
              // Quest-level write-off (uncollected part of the whole settlement,
              // tools included), recorded on the chat settlement event so
              // collected revenue = sum(creditsCharged) - sum(writtenOffCredits).
              writtenOffCredits: writtenOffCredits > 0 ? writtenOffCredits : undefined,
              status: 'ok',
              latencyMs: Date.now() - processStartTime,
            })
            .catch((usageEventError: unknown) => {
              logger.warn('Failed to record usage event', usageEventError);
            });

          try {
            // Reconcile on the pre-computed, zero-floored delta (see
            // computeSettlementDelta for the clamp semantics).
            const delta = settlementDelta;
            let reconciledHolder: ICreditHolder | null = this.reservedCreditHolder;

            if (delta !== 0 && this.reservedCreditsOwnerId) {
              // delta > 0: we over-reserved, refund the excess back
              // delta < 0: we under-reserved, charge the shortfall
              const reconcileMethod =
                this.reservedCreditsOwnerType === CreditHolderType.Organization ? this.db.organizations : this.db.users;
              reconciledHolder = await reconcileMethod.incrementCredits(this.reservedCreditsOwnerId, delta);
              logger.info(
                `⚖️ Credits reconciled for quest ${quest.id}: reserved=${this.reservedCredits}, actual=${totalCreditsUsed}, delta=${delta}`
              );
            }

            // Record audit-trail transactions with skipBalanceUpdate (balance already settled)
            if (toolCreditsUsed > 0) {
              const toolNames = (quest.promptMeta!.functionCalls || [])
                .filter(fc => fc.creditsUsed && fc.creditsUsed > 0)
                .map(fc => fc.name)
                .join(', ');
              await subtractCredits(
                {
                  type: 'tool_usage',
                  model: currentModel.id,
                  sessionId: quest.sessionId,
                  questId: quest.id,
                  ownerId: this.reservedCreditsOwnerId || this.user.id,
                  ownerType: this.reservedCreditsOwnerType,
                  credits: toolCreditsUsed,
                  description: `Tool usage: ${toolNames}`,
                  source: 'web',
                },
                {
                  db: {
                    creditTransactions: this.db.creditTransactions,
                  },
                  creditHolderMethods:
                    this.reservedCreditsOwnerType === CreditHolderType.Organization
                      ? this.db.organizations
                      : this.db.users,
                  skipBalanceUpdate: true,
                  currentCreditHolder: reconciledHolder ?? undefined,
                }
              );
            }

            await deductCreditsWithOrgSupport(
              {
                type: 'text_generation_usage',
                user: this.user,
                organization,
                credits: textCreditsUsed,
                sessionId: quest.sessionId,
                questId: quest.id,
                model: currentModel.id,
                inputTokens,
                outputTokens,
              },
              {
                db: {
                  creditTransactions: this.db.creditTransactions,
                  users: this.db.users,
                  organizations: this.db.organizations,
                },
              },
              {
                skipBalanceUpdate: true,
                currentCreditHolder: reconciledHolder ?? undefined,
              }
            );

            // Reset reservation state after successful reconciliation
            this.reservedCredits = 0;
            this.reservedCreditHolder = null;
          } catch (creditError) {
            logger.error(
              `🚨 Credits reconciliation failed for quest ${quest.id} (${totalCreditsUsed} credits used, ${this.reservedCredits} reserved). Manual reconciliation needed.`,
              creditError
            );
            // Do not re-throw: balance already adjusted at reservation time
            // Audit trail failure is logged above; request has already been served
          }
        }

        const totalResponseTime = Date.now() - processStartTime;
        quest.promptMeta!.performance!.totalResponseTime = totalResponseTime;
        // Stamp when this completion's data was finalized so the debug report shows an
        // absolute date-time (durations alone don't tell you when the run happened).
        quest.promptMeta!.generatedAt = new Date().toISOString();

        // Phase 2: Populate context debug information
        if (!quest.promptMeta!.context) {
          quest.promptMeta!.context = {};
        }

        // Context window usage tracking
        const utilizationPercentage = (inputTokens / maxSafeInputTokens) * 100;
        quest.promptMeta!.context!.contextWindowUsage = {
          contextLimit,
          maxOutputTokens: safeMaxTokens,
          safeMaxInputTokens: maxSafeInputTokens,
          actualInputTokens: inputTokens,
          bufferTokens: safetyBuffer,
          utilizationPercentage: parseFloat(utilizationPercentage.toFixed(2)),
          overflowDetected: inputTokens > maxSafeInputTokens,
          overflowAmount: inputTokens > maxSafeInputTokens ? inputTokens - maxSafeInputTokens : undefined,
        };

        // Message truncation tracking
        if (messageTruncationInfo) {
          quest.promptMeta!.context!.messageTruncation = messageTruncationInfo;
        }

        // Tool health tracking
        const toolHealthData = this.toolValidator.getAllToolsHealth(sessionId);
        if (toolHealthData.size > 0) {
          quest.promptMeta!.toolHealth = Array.from(toolHealthData.entries()).map(([toolName, health]) => ({
            toolName,
            available: health.available,
            failureCount: health.failureCount,
            lastError: health.lastError,
            lastChecked: health.lastChecked,
          }));
        }

        // Surface the provider's stop reason so truncated responses are no longer
        // silent. 'max_tokens' means generation was cut off against the
        // output-token ceiling - which is what leaves a large artifact unclosed.
        // Persisted on promptMeta so the client can render a truncation/recovery
        // affordance instead of falling through to raw HTML.
        const providerStopReason = actualTokenUsage?.stopReason;
        const wasTruncated = providerStopReason === 'max_tokens';
        if (quest.promptMeta) {
          quest.promptMeta.finishReason = providerStopReason;
        }
        if (wasTruncated) {
          logger.warn(
            // NOTE: safeMaxTokens is the value this layer *requested*. For adaptive
            // thinking models the backend raises it to an internal floor (see
            // buildThinkingParams), so the effective API ceiling can be higher than
            // this number - hence "requested" rather than the actual ceiling.
            `⚠️ [Truncation] Response hit max_tokens ceiling (model=${currentModel.id}, outputTokens=${outputTokens}, requestedMaxTokens=${safeMaxTokens}). Output may be truncated mid-artifact (#9259).`
          );
          if (quest.promptMeta) {
            quest.promptMeta.warnings = [
              ...(quest.promptMeta.warnings ?? []),
              'Response was truncated against the output-token limit (max_tokens). Large artifacts may be incomplete.',
            ];
          }
        }

        quest.status = 'done';

        // Context Telemetry: Finalize and attach to promptMeta
        if (telemetryBuilder) {
          try {
            // Determine finish reason based on completion state. A max_tokens stop
            // takes precedence - it maps to the telemetry 'length' bucket so
            // truncation is observable in dashboards.
            const hasToolCalls = (quest.promptMeta?.functionCalls?.length ?? 0) > 0;
            const finishReason = wasTruncated ? 'length' : hasToolCalls ? 'tool_use' : 'stop';

            telemetryBuilder.setFinishReason(finishReason);
            telemetryBuilder.setUsedTools(hasToolCalls);

            // Set performance metrics (use promptMeta values which are set earlier)
            telemetryBuilder.setPerformance({
              totalResponseTimeMs: totalResponseTime,
              modelInferenceMs: quest.promptMeta?.performance?.modelInferenceTime,
            });

            // Set context window metrics (for M3, but initialize here)
            telemetryBuilder.setContextWindow({
              inputTokens,
              outputTokens,
              contextWindowLimit: contextLimit,
              utilizationPercentage: parseFloat(utilizationPercentage.toFixed(2)),
              reservedOutputTokens: safeMaxTokens,
              overflowDetected: inputTokens > maxSafeInputTokens,
              overflowAmount: inputTokens > maxSafeInputTokens ? inputTokens - maxSafeInputTokens : undefined,
            });

            // Set costs (use quest.creditsUsed which is set in credits block)
            telemetryBuilder.setCosts({
              creditsUsed: quest.creditsUsed ?? 0,
            });

            // Set request metadata
            telemetryBuilder.setRequestMetadata({
              queryComplexity: isSimpleQuery ? 'simple' : 'complex',
              historyMessageCount: historyCount,
              attachedFileCount: sessionFabFileIds?.length ?? 0,
              mementoCount: quest.promptMeta?.context?.mementoCount ?? 0,
              enabledFeatures: Array.from(this.features.keys()),
            });

            // M4: Tool execution telemetry
            if (toolHealthData.size > 0 || (quest.promptMeta?.functionCalls?.length ?? 0) > 0) {
              const toolTelemetryMap = new Map<string, ToolTelemetry>();

              // Populate from function calls (invocations)
              for (const fc of quest.promptMeta?.functionCalls ?? []) {
                const toolName = fc.name ?? 'unknown';
                const existing = toolTelemetryMap.get(toolName);
                if (existing) {
                  existing.invocationCount++;
                  existing.successCount++; // Assume success if no error
                } else {
                  toolTelemetryMap.set(toolName, {
                    toolName,
                    isMcpTool: toolName.includes(':') || toolName.startsWith('mcp_'),
                    mcpServerName: toolName.includes(':') ? toolName.split(':')[0] : undefined,
                    invocationCount: 1,
                    successCount: 1,
                    failureCount: 0,
                    totalDurationMs: 0, // Not tracked per-call yet
                    maxDurationMs: 0,
                    retryCount: 0,
                  });
                }
              }

              // Merge with tool health data (failures, errors)
              for (const [toolName, health] of toolHealthData) {
                const existing = toolTelemetryMap.get(toolName);
                if (existing) {
                  existing.failureCount = health.failureCount;
                  if (!health.available) {
                    existing.successCount = Math.max(0, existing.invocationCount - health.failureCount);
                  }
                  if (health.lastError) {
                    existing.lastError = sanitizeTelemetryError(health.lastError, 200);
                    const errorCategory = categorizeToolError(health.lastError);
                    existing.errorCategories = [errorCategory];
                  }
                } else if (health.failureCount > 0) {
                  // Tool failed without successful invocation
                  const errorCategories: ToolErrorCategory[] = health.lastError
                    ? [categorizeToolError(health.lastError)]
                    : [];
                  toolTelemetryMap.set(toolName, {
                    toolName,
                    isMcpTool: toolName.includes(':') || toolName.startsWith('mcp_'),
                    mcpServerName: toolName.includes(':') ? toolName.split(':')[0] : undefined,
                    invocationCount: health.failureCount,
                    successCount: 0,
                    failureCount: health.failureCount,
                    totalDurationMs: 0,
                    maxDurationMs: 0,
                    retryCount: 0,
                    lastError: health.lastError ? sanitizeTelemetryError(health.lastError, 200) : undefined,
                    errorCategories: errorCategories.length > 0 ? errorCategories : undefined,
                  });
                }
              }

              // Enrich web_fetch with content-size + truncation metrics aggregated from the
              // citables it emitted. Silent truncation is invisible in invocation/success counts alone.
              const webFetchEntry = toolTelemetryMap.get('web_fetch');
              if (webFetchEntry) {
                const sizes = aggregateWebFetchContentTelemetry(quest.promptMeta?.citables);
                webFetchEntry.truncatedInvocationCount = sizes.truncatedInvocationCount;
                webFetchEntry.totalExtractedChars = sizes.totalExtractedChars;
                webFetchEntry.maxExtractedChars = sizes.maxExtractedChars;
              }

              // Set tools on telemetry builder
              if (toolTelemetryMap.size > 0) {
                telemetryBuilder.setTools(Array.from(toolTelemetryMap.values()));
                logger.info(`📊 [Telemetry] Tool telemetry captured for ${toolTelemetryMap.size} tools`);
              }
            }

            // M5: Sub-agent telemetry
            if (this.subagentTelemetryData.length > 0) {
              // Aggregate subagent data by agent name
              const subagentMap = new Map<
                string,
                {
                  delegationCount: number;
                  successCount: number;
                  failureCount: number;
                  timeoutCount: number;
                  totalDurationMs: number;
                  totalTokensUsed: number;
                  thoroughness?: 'quick' | 'medium' | 'very_thorough';
                }
              >();

              for (const data of this.subagentTelemetryData) {
                const existing = subagentMap.get(data.agentName);
                if (existing) {
                  existing.delegationCount++;
                  existing.successCount += data.success ? 1 : 0;
                  existing.failureCount += data.success ? 0 : 1;
                  existing.timeoutCount += data.isTimeout ? 1 : 0;
                  existing.totalDurationMs += data.durationMs;
                  existing.totalTokensUsed += data.totalTokensUsed;
                } else {
                  subagentMap.set(data.agentName, {
                    delegationCount: 1,
                    successCount: data.success ? 1 : 0,
                    failureCount: data.success ? 0 : 1,
                    timeoutCount: data.isTimeout ? 1 : 0,
                    totalDurationMs: data.durationMs,
                    totalTokensUsed: data.totalTokensUsed,
                    thoroughness: data.thoroughness,
                  });
                }
              }

              // Convert to SubagentTelemetry format
              const subagentTelemetry = Array.from(subagentMap.entries()).map(([agentName, stats]) => ({
                agentName,
                delegationCount: stats.delegationCount,
                successCount: stats.successCount,
                failureCount: stats.failureCount,
                timeoutCount: stats.timeoutCount,
                totalDurationMs: stats.totalDurationMs,
                totalTokensUsed: stats.totalTokensUsed,
                thoroughness: stats.thoroughness,
              }));

              telemetryBuilder.setSubagents(subagentTelemetry);
              logger.info(`📊 [Telemetry] Subagent telemetry captured for ${subagentTelemetry.length} agents`);

              // Clear subagent data for next quest
              this.subagentTelemetryData = [];
            }

            // Set truncation info if available
            if (messageTruncationInfo) {
              telemetryBuilder.setTruncation({
                wasTruncated: messageTruncationInfo.wasTruncated,
                originalMessageCount: messageTruncationInfo.originalMessageCount,
                finalMessageCount: messageTruncationInfo.truncatedMessageCount,
                truncatedMessageCount:
                  messageTruncationInfo.originalMessageCount - messageTruncationInfo.truncatedMessageCount,
                truncationMethod: messageTruncationInfo.truncationMethod,
                truncationPercentage:
                  messageTruncationInfo.originalMessageCount > 0
                    ? ((messageTruncationInfo.originalMessageCount - messageTruncationInfo.truncatedMessageCount) /
                        messageTruncationInfo.originalMessageCount) *
                      100
                    : 0,
              });
            }

            // Build and attach telemetry
            const contextTelemetry = telemetryBuilder.build();
            quest.promptMeta!.contextTelemetry = contextTelemetry;

            logger.info(
              `📊 [Telemetry] Context telemetry captured for quest ${questId} (anomaly score: ${contextTelemetry.anomalies.anomalyScore})`
            );

            // M6: Send anomaly alerts if configured
            try {
              const alertConfigRaw = getSettingsValue('contextTelemetryAlerts', defaultAdminSettings);
              if (alertConfigRaw && typeof alertConfigRaw === 'object') {
                const alertConfigParsed = ContextTelemetryAlertsSchema.safeParse(alertConfigRaw);
                // Only publish alerts for anomalyScore > 0 to reduce noise from healthy completions
                if (
                  alertConfigParsed.success &&
                  alertConfigParsed.data.enabled &&
                  contextTelemetry.anomalies.anomalyScore > 0
                ) {
                  // Use the EventBridge publisher if available (async processing by dedicated Lambda)
                  if (this.publishTelemetryAlert) {
                    // Await to ensure event is published before Lambda terminates
                    // The actual alert processing happens asynchronously in the subscriber Lambda
                    try {
                      await this.publishTelemetryAlert({
                        telemetry: contextTelemetry,
                        alertConfig: alertConfigParsed.data,
                        requestId: questId,
                      });
                      logger.debug('📊 [Telemetry] Alert event published to EventBridge');
                    } catch (alertError) {
                      // Log but don't fail the completion - alert delivery is best-effort
                      logger.warn(`📊 [Telemetry] Failed to publish alert event:`, alertError);
                    }
                  } else {
                    // Fallback to basic in-memory dedup (no Slack/GitHub without callback)
                    const alertService = new AnomalyAlertService({
                      logger,
                      alertConfig: alertConfigParsed.data,
                      cacheRepository: this.cacheRepository,
                    });
                    // Fire-and-forget: don't block completion for alerts
                    alertService.checkAndAlert(contextTelemetry).catch(alertError => {
                      logger.warn(`📊 [Telemetry] Alert check failed:`, alertError);
                    });
                  }
                }
              }
            } catch (alertConfigError) {
              logger.warn(`📊 [Telemetry] Failed to parse alert config:`, alertConfigError);
            }
          } catch (telemetryError) {
            logger.warn(`📊 [Telemetry] Failed to finalize telemetry:`, telemetryError);
          }
        }

        quest.status = 'done';

        timer.phase('save');

        // P4-b: Fire-and-forget status update, don't block on WebSocket delivery
        this.sendStatusUpdate(quest, `Completed Quest`, { statusAt: new Date(), silent: true });

        // Run quest save in parallel with fire-and-forget on_complete features
        // EventBridge-publishing features don't need the quest to be saved first
        timer.phase('on_complete');
        const onCompleteStartTime = Date.now();

        const fireAndForgetFeatures: Array<featureNames> = [
          'slack',
          'autoNameSession', // Publishes event to EventBridge
          'summarizeNotebook', // Publishes event to EventBridge
          'contextSummarization', // Publishes event to EventBridge
        ];
        const postSaveFeatures: Array<featureNames> = ['mementos', 'questMaster'];

        // P5-a: Truly fire-and-forget the EventBridge features - don't await them.
        fireAndForgetFeatures.forEach(feature => {
          this.features
            .get(feature)
            ?.onComplete({ quest, session, messages, questMaster, model, historyCount, oldestIncludedQuestId })
            ?.catch(err => logger.error(`Error in fire-and-forget ${feature} onComplete:`, err));
        });

        // P6: Await critical save - replies and status MUST persist to MongoDB before the
        // Lambda handler returns, otherwise Lambda may freeze the execution context and the
        // write is lost. The client already has the streamed response, but page refreshes
        // load from DB. (Perf note: only this save is awaited; P4-c metadata save below
        // remains fire-and-forget since losing perf data is harmless.)
        await saveQuest(quest);

        // P4-a: Post-save features (mementos, questMaster) create side-effect documents -
        // they don't affect quest.reply/replies. Fire-and-forget to avoid blocking response.
        const postSavePromises = postSaveFeatures
          .map(feature =>
            this.features
              .get(feature)
              ?.onComplete({ quest, session, messages, questMaster, model, historyCount, oldestIncludedQuestId })
          )
          .filter(p => p);

        // Don't await - let them run in background. Errors are caught and logged.
        Promise.allSettled(postSavePromises).then(results => {
          results.forEach(result => {
            if (result.status === 'rejected') {
              logger.error('Error in post-save feature onComplete:', result.reason);
            }
          });
        });

        // Capture actual onComplete duration
        actualOnCompleteDuration = Date.now() - onCompleteStartTime;

        logger.info(
          `⏱️ [${Date.now() - processStartTime}ms] OnComplete features finished in ${actualOnCompleteDuration}ms`
        );

        // Update feature execution times with actual onComplete duration
        quest.promptMeta!.performance!.featureExecutionTimes!.set('onCompleteFeatures', actualOnCompleteDuration);
        logger.info(`🔍 [DEBUG] Updated onCompleteFeatures performance data: ${actualOnCompleteDuration}ms`);

        // Store pipeline phases on quest and log structured summary
        timer.end();
        const phases = timer.toRecord();
        quest.promptMeta!.performance!.phases = phases;
        this.pipelinePhases = phases;
        logger.info(`📊 Pipeline phases:\n${timer.summary()}`);

        // P4-c: Fire-and-forget final save - only adds performance metadata to quest.
        // Critical data (replies, status) already saved in on_complete. Pipeline phases
        // are read from processService.pipelinePhases (in-memory) for the response.
        saveQuest(quest)
          .then(q => {
            finalQuest = q;
          })
          .catch(err => {
            logger.error('Error in final performance save:', err);
          });

        const totalProcessTime = Date.now() - processStartTime;
        logger.info(`⏱️ === LLM COMPLETION PROCESS FINISHED in ${totalProcessTime}ms ===`);
      } catch (postProcessError) {
        // Post-streaming processing failed, but the reply is already streamed.
        // Do NOT overwrite quest.reply, quest.replies, or quest.status - keep status as 'done'.
        logger.error(`❌ [POST_PROCESS] Error in post-streaming processing for quest ${questId}:`, postProcessError);
        quest.status = 'done';
        // Ensure quest is persisted as 'done' even if the error occurred before the normal save
        await saveQuest(quest);
      }
    } catch (err) {
      const totalResponseTime = Date.now() - processStartTime;

      // Rollback reserved credits if we never completed reconciliation
      if (this.reservedCredits > 0 && this.reservedCreditsOwnerId) {
        try {
          const rollbackMethod =
            this.reservedCreditsOwnerType === CreditHolderType.Organization ? this.db.organizations : this.db.users;
          await rollbackMethod.incrementCredits(this.reservedCreditsOwnerId, this.reservedCredits);
          logger.info(`💰 Rolled back ${this.reservedCredits} reserved credits for quest ${questId} due to error`);
          this.reservedCredits = 0;
          this.reservedCreditHolder = null;
        } catch (rollbackError) {
          logger.error(
            `🚨 CRITICAL: Failed to rollback ${this.reservedCredits} reserved credits for quest ${questId} (ownerType=${this.reservedCreditsOwnerType}). Manual reconciliation required.`,
            rollbackError
          );
        }
      }

      quest.promptMeta!.performance!.totalResponseTime = totalResponseTime;
      quest.promptMeta!.generatedAt = new Date().toISOString();
      quest.reply = (err as Error).message;
      quest.type = 'error';
      quest.status = 'done';
      // Classifier for the client's "Add Credits" CTA. Chat reservation throws
      // InsufficientCreditsError (code unset by the dispute-pending fraud gates);
      // mid-turn generation tools throw a getQuestErrorCode-tagged 422.
      const questErrorCode = err instanceof InsufficientCreditsError ? err.code : getQuestErrorCode(err);
      if (questErrorCode) {
        quest.errorCode = questErrorCode;
      }

      const errorSaveStartTime = Date.now();
      finalQuest = await saveQuest(quest);
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Error quest save completed in ${Date.now() - errorSaveStartTime}ms`
      );

      if (err instanceof InsufficientCreditsError || questErrorCode) {
        // Terminal: nothing to retry until credits are added, so return without re-throwing
        // (a throw would route the queue handler to DLQ/retry). Quest already saved above.
        logger.log(`Insufficient credits for quest ${questId}`);
        return;
      } else if (err instanceof Error && (err.message.toLowerCase().includes('aborted') || err.name === 'AbortError')) {
        logger.log(`Chat completion was stopped by user for quest ${questId}: ${err.message}`);
        quest.reply = 'The request was interrupted. Please try sending your message again.';
        quest.type = 'error';
        quest.status = 'done';
        finalQuest = await saveQuest(quest);
        return;
      } else if (
        err instanceof Error &&
        (err.message.includes('request timeout') || err.message.includes('stream timeout'))
      ) {
        // WARN, not error: an upstream request/idle timeout is expected and
        // recoverable (the user gets the retry message below and the backend
        // already emitted trend metrics). Logging at error severity re-trips the
        // CloudWatch ERROR to LiveOps/Slack alert path that the backend WARN downgrade
        // was meant to avoid.
        logger.warn(`[Timeout] Quest ${questId}: ${err.message}`);
        quest.reply = 'The AI service is currently experiencing high demand. Please try again in a few minutes.';
        quest.type = 'error';
        quest.status = 'done';
        finalQuest = await saveQuest(quest);
        return;
      } else if (err instanceof Error && isToolPairingError(err)) {
        // User-friendly error message instead of stuck spinner
        logger.error(`[Tool Pairing Error] Quest ${questId}: ${err.message}`);
        quest.reply = 'I encountered an issue with the conversation history. Please try again or start a new session.';
        quest.type = 'error';
        quest.status = 'done';
        finalQuest = await saveQuest(quest);
        return;
      } else if (err instanceof Error && isOverloadedError(err)) {
        logger.error(`[Overloaded Error] Quest ${questId}: ${err.message}`);
        quest.reply = 'The AI service is currently experiencing high demand. Please try again in a few minutes.';
        quest.type = 'error';
        quest.status = 'done';
        finalQuest = await saveQuest(quest);
        return;
      } else if (err instanceof Error && err.message.startsWith('Your request is too large for')) {
        logger.error(`[Context Overflow] Quest ${questId}: ${err.message}`);
        // quest.reply already set to err.message above (line 2825) - includes token breakdown
        return;
      }
      throw err;
    } finally {
      if (cancelWatcherInterval) {
        clearInterval(cancelWatcherInterval);
      }
      if (streamingHeartbeatInterval) {
        clearInterval(streamingHeartbeatInterval);
        streamingHeartbeatInterval = null;
      }
      const finalStatusStartTime = Date.now();
      // Use quest directly - finalQuest may not be set if the final save was fire-and-forget
      if (finalQuest || quest) {
        this.sendStatusUpdate(finalQuest ?? quest, null, { skipPayloadOptimization: true });
      }
      logger.info(
        `⏱️ [${Date.now() - processStartTime}ms] Final status updates completed in ${
          Date.now() - finalStatusStartTime
        }ms`
      );

      const totalFinalTime = Date.now() - processStartTime;
      logger.info(`⏱️ === TOTAL PROCESS TIME: ${totalFinalTime}ms ===`);
    }
  }

  public async sendStatusUpdate(
    q: IChatHistoryItemDocument,
    status: string | null,
    options: {
      /** If true, the status message will not be sent to the client. */
      silent?: boolean;
      /** Skip throttling for immediate updates (like errors or completion) */
      immediate?: boolean;
      statusAt?: Date;
      skipPayloadOptimization?: boolean;
    } = {}
  ) {
    if (!this.statusManager) {
      // IF NOT INITIALIZED, INITIALIZE IT
      this.statusManager = new StatusManager(
        new ClientMessageSender(this.db, this.logger),
        this.logger,
        this.wsHttpsUrl,
        this.user.id
      );
      this.logger.info('StatusManager initialized');

      return;
    }

    return this.statusManager.sendStatusUpdate(q, status, options);
  }

  public async sendStatusUpdateRapidReply(
    q: IChatHistoryItemDocument,
    status: string | null,
    options: {
      /** If true, the status message will not be sent to the client. */
      silent?: boolean;
      /** Skip throttling for immediate updates (like errors or completion) */
      immediate?: boolean;
      statusAt?: Date;
      skipPayloadOptimization?: boolean;
    } = {}
  ) {
    if (!this.statusManager) {
      // IF NOT INITIALIZED, INITIALIZE IT
      this.statusManager = new StatusManager(
        new ClientMessageSender(this.db, this.logger),
        this.logger,
        this.wsHttpsUrl,
        this.user.id
      );
      this.logger.info('StatusManager initialized');

      return this.statusManager.sendStatusUpdate(q, status, options);
    }

    return this.statusManager.sendStatusUpdate(q, status, options);
  }

  /**
   * Send Research Mode streaming updates for individual configurations
   */
  private async sendResearchModeStreamUpdate(
    quest: IChatHistoryItemDocument,
    configurationId: string,
    streamedTexts: (string | null | undefined)[],
    completionInfo?: unknown
  ) {
    try {
      // Create a special Research Mode streaming payload
      const payload = {
        action: 'research_mode_stream' as const,
        quest: {
          id: quest.id,
          sessionId: quest.sessionId,
        },
        researchMode: {
          configurationId,
          streamedTexts,
          completionInfo,
        },
      };

      // Send directly to client using a new ClientMessageSender instance
      const clientMessageSender = new ClientMessageSender(this.db, this.logger);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await clientMessageSender.sendToClient(this.user.id, this.wsHttpsUrl, payload as any);
    } catch (error) {
      this.logger.error(`Failed to send Research Mode stream update for config ${configurationId}:`, error);
    }
  }

  public async fabFilesToMessages(
    fabFileIds: string[],
    quest: IChatHistoryItemDocument,
    embeddingFactory: EmbeddingFactory,
    message: string,
    max_tokens: number,
    modelInfo: ModelInfo
  ) {
    const scope = this.getScopeFilter(this.user, Permission.read, 'FabFile');
    const convertedFabFiles = await fetchAndConvertFabFiles(
      fabFileIds,
      { scope },
      { db: this.db, storage: this.storage }
    );
    const {
      userMessages: promptMessages,
      // errorMessages,
    } = await processFabFilesServer(
      embeddingFactory,
      convertedFabFiles,
      message,
      max_tokens,
      modelInfo,
      async status => {
        this.sendStatusUpdate(quest, status, { statusAt: new Date() });
      },
      {
        db: this.db,
        logger: this.logger,
        storage: this.storage,
      }
    );

    // Add file metadata system message if there are files (for tools like edit_image).
    // Also require serveable so the LLM is never told the fabFileId of a
    // held/blocked image (that ID is what makes it reachable via edit_image, etc.).
    const imageFiles = convertedFabFiles.filter(file => file.mimeType.startsWith('image/') && isImageServeable(file));
    if (imageFiles.length > 0) {
      const fileList = imageFiles
        .map(file => `- "${file.fileName}" (fabFileId: ${file.id}, type: ${file.mimeType})`)
        .join('\n');

      promptMessages.unshift({
        role: 'system',
        content: `# Available Files

The user has attached ${imageFiles.length} image file${imageFiles.length > 1 ? 's' : ''} to this conversation:

${fileList}

When the user asks to upload/attach files, delegate via delegate_to_agent with the attachedFiles parameter using the exact filenames and fabFileIds above.
NEVER rename files based on image content — always use the exact filename shown.
When using tools that require file IDs (like edit_image), use the ID shown above.`,
      });
    }

    const result = { promptMessages, convertedFabFiles };
    return result;
  }

  private async validateUserCredits(
    model: ModelInfo,
    inputTokens: number,
    maxOutputTokens: number,
    organization?: IOrganizationDocument | null
  ) {
    // Secondary dispute check: catches mid-stream tool invocations (e.g. image generation)
    if (this.user.disputePending) {
      throw new InsufficientCreditsError(
        'Your account is under review due to a payment dispute. Please contact support to resolve this.'
      );
    }

    let userCredits = this.user.currentCredits ?? 0;
    this.logger.updateMetadata({ creditsSource: 'user', creditsSourceId: this.user.id });

    if (organization) {
      this.logger.updateMetadata({ creditsSource: 'organization', creditsSourceId: organization.id });
      userCredits = organization.currentCredits;
    }

    const usdCost = getTextModelCost(model, inputTokens, maxOutputTokens);
    const requiredCredits = usdToCredits(usdCost);

    // Check if current credits are below the alert threshold
    if (userCredits < LOW_CREDIT_ALERT_THRESHOLD) {
      // Send low credits notification for current balance using deduplication
      const { getNotificationDeduplicator } = await import('@bike4mind/utils');
      getNotificationDeduplicator()
        .handleLowCreditNotification(
          this.user.id,
          this.user.name || 'Unknown',
          this.user.email || 'No email',
          userCredits,
          organization ? { id: organization.id, name: organization.name } : null,
          this.slackWebhookUrl
        )
        .catch((error: Error) => {
          this.logger.error('Failed to send low credits notification:', error);
        });
    }

    // Check if there are enough credits for the operation
    if (userCredits < requiredCredits) {
      const errorMessage = organization
        ? `Your organization "${organization.name}" does not have enough credits to complete this request. The organization currently has ${userCredits} credits, and this request requires ${requiredCredits} credits. Please contact your organization administrator to add more credits.`
        : `You do not have enough credits to complete this request. You currently have ${userCredits} credits, and this request requires ${requiredCredits} credits. Try adjusting your prompt to be more concise or reducing the number of chat history messages to lower the credit cost.`;
      throw new InsufficientCreditsError(errorMessage);
    }

    // Check if credits will be below the alert threshold after this operation
    const remainingCredits = userCredits - requiredCredits;
    if (remainingCredits < LOW_CREDIT_ALERT_THRESHOLD) {
      // Send low credits notification using deduplication
      const { getNotificationDeduplicator } = await import('@bike4mind/utils');
      getNotificationDeduplicator()
        .handleLowCreditNotification(
          this.user.id,
          this.user.name || 'Unknown',
          this.user.email || 'No email',
          remainingCredits,
          organization ? { id: organization.id, name: organization.name } : null,
          this.slackWebhookUrl
        )
        .catch((error: Error) => {
          this.logger.error('Failed to send low credits notification:', error);
        });
    }

    return requiredCredits;
  }

  /**
   * Provide default admin settings for immediate LLM start.
   * Safe defaults that let the system function without waiting for DB.
   */
  private getDefaultAdminSettings(): Partial<Record<SettingKey, string>> {
    return {
      // Feature toggles - default to enabled for best user experience
      EnableQuestMaster: 'true',
      EnableMementos: 'true',
      EnableArtifacts: 'true',
      EnableAgents: 'true',
      AutoNameNotebook: 'true',
      EnableMCPServer: 'false',

      // Safety settings - default to secure
      ModerationEnabled: 'false', // Don't block on moderation by default
      enforceCredits: 'true', // Enforce credits by default (secure default)

      // System settings - safe defaults
      SystemFiles: '',

      // Demo keys - will be overridden by real settings when available
      openaiDemoKey: '',
      anthropicDemoKey: '',
      geminiDemoKey: '',
      bflApiKey: '',
      xaiApiKey: '',
      ollamaBackend: '',
      EnableOllama: 'false',
    };
  }

  /**
   * Load admin settings in background (non-blocking).
   * Returns a promise that resolves when real settings are available.
   */
  private async loadAdminSettingsAsync(logger: Logger, processStartTime: number): Promise<Record<string, string>> {
    const adminSettingsStartTime = Date.now();

    try {
      logger.info(`⏱️ [${Date.now() - processStartTime}ms] Background admin settings fetch started`);

      const adminSettings = await getSettingsMap(this.db, { logger });

      const fetchTime = Date.now() - adminSettingsStartTime;
      logger.info(`⏱️ [${Date.now() - processStartTime}ms] Background admin settings completed in ${fetchTime}ms`);

      return adminSettings;
    } catch (error) {
      logger.warn(`Background admin settings fetch failed after ${Date.now() - adminSettingsStartTime}ms:`, error);
      // Return defaults if background fetch fails
      return this.getDefaultAdminSettings();
    }
  }

  /**
   * Get setting value with default fallback.
   * Works with both default settings and real admin settings.
   */
  private getDefaultSettingValue(key: string, settings: Record<string, string | number | boolean>): boolean {
    const value = settings[key];
    if (!value) return false;
    return value.toString().toLowerCase() === 'true' || value.toString() === '1';
  }

  private async buildOptimizedFeatures(
    adminSettings: Record<string, string>,
    enableQuestMaster: boolean,
    enableMementos: boolean,
    enableAgents: boolean,
    projectId?: string,
    optimizedFeatureList: featureNames[] = [],
    organization?: IOrganizationDocument | null,
    systemPromptText?: string,
    forceKnowledgeRetrieval?: boolean,
    retrievalTags?: string[],
    citationStyle?: 'named' | 'indexed'
  ) {
    const adminSettingsEnableMementos = getSettingsValue('EnableMementos', adminSettings);
    const adminSettingsEnableQuestMaster = getSettingsValue('EnableQuestMaster', adminSettings);
    const adminSettingsEnableAgents = getSettingsValue('EnableAgents', adminSettings);
    const adminSettingsAutoNameNotebook = getSettingsValue('AutoNameNotebook', adminSettings);

    // Only build features that are in the optimized list
    this.logger.log(`🛠️ Building optimized features: ${optimizedFeatureList.join(', ')}`);

    // Always-available lightweight features
    if (optimizedFeatureList.includes('slack')) {
      this.features.set('slack', new SlackFeature(this));
    }

    if (optimizedFeatureList.includes('summarizeNotebook')) {
      this.features.set('summarizeNotebook', new SummarizeNotebookFeature(this));
    }

    if (optimizedFeatureList.includes('contextSummarization')) {
      this.features.set('contextSummarization', new ContextSummarizationFeature(this));
    }

    // Conditional features - only build if requested AND enabled
    if (optimizedFeatureList.includes('mementos') && enableMementos && adminSettingsEnableMementos) {
      this.logger.log('  - Enabling Mementos feature');
      this.features.set('mementos', new MementoFeature(this));
    }

    if (optimizedFeatureList.includes('autoNameSession') && adminSettingsAutoNameNotebook) {
      this.logger.log('  - Enabling AutoNameSession feature');
      this.features.set('autoNameSession', new AutoNameSessionFeature(this, adminSettingsAutoNameNotebook));
    }

    if (optimizedFeatureList.includes('questMaster') && enableQuestMaster && adminSettingsEnableQuestMaster) {
      this.logger.log('  - Enabling QuestMaster feature');
      this.features.set('questMaster', new QuestMasterFeature(this));
    }

    // Agent feature initialization
    if (optimizedFeatureList.includes('agentDetection') && enableAgents && adminSettingsEnableAgents) {
      this.logger.log('  - Enabling AgentDetection feature');
      this.features.set('agentDetection', new AgentDetectionFeature(this));
    }

    // Skills feature - expands `/skill-name args` invocations into the system
    // prompt. Always on when the optimized list requests it AND the host has
    // wired the skill repository (db.skills is optional, see ChatCompletionFeatures).
    if (optimizedFeatureList.includes('skills') && this.db.skills) {
      this.logger.log('  - Enabling Skills feature');
      this.features.set('skills', new SkillsFeature(this));
    }

    // Project feature - only if needed and available
    if (projectId) {
      const project = await this.db.projects.findById(projectId);
      if (project) {
        this.logger.log('  - Enabling Project feature');
        this.features.set('project', new ProjectFeature(this, project));
      }
    }

    // Organization prompt feature - always enabled if user has an organization with a system prompt.
    // Injects organization-level context for enterprise customers (a firm scoping its assistant to a domain).
    // Use the organization from the current session context (passed in), not the user's default org.
    if (organization?.systemPrompt) {
      this.logger.log(`  - Enabling OrganizationPrompt feature for "${organization.name}"`);
      this.features.set('organizationPrompt', new OrganizationPromptFeature(this, organization));
    }

    // Session prompt feature - generic per-session system prompt (e.g. product
    // surfaces that scope a session's behavior without a project record).
    if (systemPromptText?.trim()) {
      this.logger.log('  - Enabling SessionPrompt feature');
      this.features.set('sessionPrompt', new SessionPromptFeature(this, systemPromptText));
    }

    // Forced knowledge retrieval - generic per-session grounding (e.g. reference
    // products that must always answer from a curated lake with citations).
    if (forceKnowledgeRetrieval) {
      this.logger.log('  - Enabling KnowledgeRetrieval (forced) feature');
      this.features.set('knowledgeRetrieval', new KnowledgeRetrievalFeature(this, retrievalTags, citationStyle));
    }

    this.logger.log(`🛠️ Features enabled: ${Array.from(this.features.keys()).join(', ')}`);
  }

  /**
   * Gather all data sources: system files, session files, message files, URLs, and fab files.
   * Handles caching of system file IDs, deduplication, and parallel URL/fab file processing.
   */
  private async buildDataSources({
    defaultAdminSettings,
    sessionFabFileIds,
    messageFileIds,
    sessionKnowledgeIds,
    message,
    maxTokens,
    quest,
    embeddingFactory,
    modelInfo,
    logger,
    processStartTime,
  }: {
    defaultAdminSettings: Record<string, string>;
    sessionFabFileIds: string[];
    messageFileIds: string[];
    sessionKnowledgeIds: string[];
    message: string;
    maxTokens: number;
    quest: IChatHistoryItemDocument;
    embeddingFactory: EmbeddingFactory;
    modelInfo: ModelInfo;
    logger: Logger;
    processStartTime: number;
  }): Promise<{
    urlMessages: IMessage[];
    remainingUserPrompt: string;
    fabMessages: IMessage[];
    convertedFabFiles: Array<{ fileName: string; mimeType: string; fileSize?: number }>;
    globalSystemFileIds: string[];
    enabledSystemFileIds: string[];
    allFileIdsBeforeDedup: string[];
    dedupedFileIds: string[];
    featureContextMessages: { [name: string]: IMessage[] };
  }> {
    // Load feature contexts in parallel with data sources
    const featureContextPromise = Promise.all(
      Array.from(this.features.entries()).map(async ([key, feature]) => {
        const featureContextIndividualStartTime = Date.now();
        try {
          const messages = await feature.getContextMessages(quest, embeddingFactory, message, maxTokens, modelInfo);

          const elapsed = Date.now() - featureContextIndividualStartTime;
          logger.info(
            `⏱️ [${Date.now() - processStartTime}ms] Feature '${key}' context messages (${
              messages.length
            } messages) retrieved in ${elapsed}ms`
          );

          return [key, messages] as [string, IMessage[]];
        } catch (error) {
          logger.error(`Feature '${key}' context loading failed:`, error);
          return [key, []] as [string, IMessage[]];
        }
      })
    );

    // Cache system file IDs to avoid redundant parsing
    const systemFilesCacheKey = `system-files-${this.user.id}`;
    if (!this.systemFilesCache) {
      this.systemFilesCache = new Map();
    }

    let globalSystemFileIds: string[];
    let enabledSystemFileIds: string[];

    const cachedSystemFiles = this.systemFilesCache.get(systemFilesCacheKey);
    if (cachedSystemFiles) {
      [globalSystemFileIds, enabledSystemFileIds] = cachedSystemFiles;
    } else {
      globalSystemFileIds =
        (getSettingsValue('SystemFiles', defaultAdminSettings) || undefined)
          ?.split(',')
          .map((id: string) => id.trim()) ?? [];
      enabledSystemFileIds = (this.user.systemFiles ?? []).filter(file => file.enabled).map(file => file.fileId);
      this.systemFilesCache.set(systemFilesCacheKey, [globalSystemFileIds, enabledSystemFileIds]);
    }

    // Pre-compute file dedup (synchronous) before deciding whether to skip
    const allFileIdsBeforeDedup = [
      ...sessionFabFileIds,
      ...messageFileIds,
      ...enabledSystemFileIds,
      ...globalSystemFileIds,
      ...sessionKnowledgeIds,
    ];
    const dedupedFileIds = Array.from(new Set(allFileIdsBeforeDedup));

    let fabMessages: IMessage[] = [];
    let convertedFabFiles: Array<{ fileName: string; mimeType: string; fileSize?: number }> = [];
    let fabResultPromise: Promise<Awaited<ReturnType<typeof this.fabFilesToMessages>> | undefined> =
      Promise.resolve(undefined);

    // URL processing runs regardless of whether there are files
    const urlResultPromise = processUrlsFromPrompt(
      message,
      maxTokens,
      this.user.id,
      async status => {
        this.sendStatusUpdate(quest, status, { statusAt: new Date() });
      },
      logger
    );

    if (dedupedFileIds.length > 0) {
      // Full data sources processing path
      const fabFilesStartTime = Date.now();

      logger.info('🔍 System Prompt Sources:', {
        globalSystemFiles: globalSystemFileIds,
        userSystemFiles: enabledSystemFileIds,
        sessionKnowledgeIds,
        messageFileIds,
        allFileIdCount: dedupedFileIds.length,
      });

      if (dedupedFileIds.length > 10) {
        this.sendStatusUpdate(quest, `Processing ${dedupedFileIds.length} data sources...`, { statusAt: new Date() });
      }

      const duplicateCount = allFileIdsBeforeDedup.length - dedupedFileIds.length;
      if (duplicateCount > 0) {
        logger.warn(`⚠️ Found ${duplicateCount} duplicate file IDs in system prompts`, {
          beforeDedup: allFileIdsBeforeDedup.length,
          afterDedup: dedupedFileIds.length,
          duplicates: allFileIdsBeforeDedup.filter((id, index) => allFileIdsBeforeDedup.indexOf(id) !== index),
        });
      }

      // Start fab file processing (awaited in parallel with URL and feature contexts below)
      fabResultPromise = this.fabFilesToMessages(
        dedupedFileIds,
        quest,
        embeddingFactory,
        message,
        maxTokens,
        modelInfo
      ).then(result => {
        logger.info(
          `⏱️ [${Date.now() - processStartTime}ms] Data sources processed in ${Date.now() - fabFilesStartTime}ms (${dedupedFileIds.length} files)`
        );
        return result;
      });
    } else {
      logger.info(`⏱️ [${Date.now() - processStartTime}ms] Data sources: no files, URL-only fast path`);
    }

    // Await all three in parallel: URL processing, feature contexts, and fab file processing
    const [urlResult, featureContextResults, fabResult] = await Promise.all([
      urlResultPromise,
      featureContextPromise,
      fabResultPromise,
    ]);
    if (fabResult) {
      fabMessages = fabResult.promptMessages;
      convertedFabFiles = fabResult.convertedFabFiles;
    }
    const featureContextMessages: { [name: string]: IMessage[] } = Object.fromEntries(featureContextResults);

    return {
      urlMessages: urlResult.userMessages,
      remainingUserPrompt: urlResult.remainingPrompt,
      fabMessages,
      convertedFabFiles,
      globalSystemFileIds,
      enabledSystemFileIds,
      allFileIdsBeforeDedup,
      dedupedFileIds,
      featureContextMessages,
    };
  }
}
