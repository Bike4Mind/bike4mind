import {
  ChatCompletionInvokeParamsSchema,
  isSupportedEmbeddingModel,
  IUserDocument,
  LLMModelConfig,
  ModelInfo,
  PromptMeta,
  PromptMetaZodSchema,
} from '@bike4mind/common';
import {
  BadRequestError,
  ForbiddenError,
  InternalServerError,
  isModelAccessible,
  isZodError,
  getSettingsByNames,
} from '@bike4mind/utils';
import { getAvailableModels } from '@bike4mind/llm-adapters';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';
import { getEffectiveLLMApiKeys } from '../apiKeyService';
import { IChatCompletionServiceOptions, QuestStartBodySchema } from './ChatCompletionFeatures';
import { classifyQueryComplexity } from './queryComplexityClassifier';
import { filterBuiltInTools } from './tools/toolManager';

export class ChatCompletionInvoke {
  public db: IChatCompletionServiceOptions['db'];
  private logger: Logger;
  private user: IUserDocument;
  private apiKeyTableCache: any | null = null;
  private modelInfoCache: ModelInfo[] | null = null;
  private modelConfigurationsCache: LLMModelConfig[] | null = null;
  private questStartParams: z.infer<typeof QuestStartBodySchema> | null = null;
  private invokeLambda?: (params: z.infer<typeof QuestStartBodySchema>) => Promise<void>;
  private getEntitlements: IChatCompletionServiceOptions['getEntitlements'];
  /** Session fetched during invoke; exposed for the wait=true path to avoid a re-fetch in process. */
  public prefetchedSession: any | null = null;
  /** Organization fetched during invoke; exposed for the wait=true path to avoid a re-fetch in process. */
  public prefetchedOrganization: any | null = null;

  constructor(options: IChatCompletionServiceOptions) {
    this.db = options.db;
    this.logger = options.logger;
    this.user = options.user;
    this.invokeLambda = options.invokeLambda;
    this.getEntitlements = options.getEntitlements;
  }

  /**
   * Resolve the caller's entitlement keys for the admission-time model gate,
   * mirroring `ChatCompletionProcess.resolveEntitlementKeys`. Fail-safe: an
   * entitlement-resolution error (e.g. a subscription DB read failure) must
   * NEVER break the send path - degrade to tag-only matching ([]), the
   * pre-entitlement behavior. No injected resolver means [] means tag-only.
   */
  private async resolveEntitlementKeys(): Promise<string[]> {
    try {
      return (await this.getEntitlements?.(this.user)) ?? [];
    } catch (err) {
      this.logger.warn(
        `Entitlement resolution failed; falling back to tag-only model access: ${(err as Error)?.message}`
      );
      return [];
    }
  }

  /**
   * Creates the quest record and enqueues it; the actual work happens in `process`.
   * Split this way so it can be driven from a queue handler (worker or serverless function).
   */
  public async invoke({ body, userId }: { body: z.infer<typeof ChatCompletionInvokeParamsSchema>; userId: string }) {
    const now = new Date();

    const {
      params,
      sessionId,
      message,
      messageFileIds,
      historyCount,
      fabFileIds,
      dashboardParams,
      questId,
      enableQuestMaster,
      enableMementos,
      enableArtifacts,
      enableAgents,
      enableLattice,
      tools,
      projectId,
      organizationId,
      questMaster,
      toolPromptId,
      researchMode,
      fallbackModel,
      embeddingModel,
      deepResearchConfig,
      imageConfig,
      mcpServers,
      extraContextMessages,
      allowedAgents,
      enableSlackTools,
    } = ChatCompletionInvokeParamsSchema.parse(body);

    // Parallelize independent operations: API keys, session, and organization fetch
    const [apiKeyTable, session, organization] = await Promise.all([
      this.apiKeyTableCache ||
        getEffectiveLLMApiKeys(userId, { db: this.db, getSettingsByNames }, { logger: new Logger() }),
      this.db.sessions.findById(sessionId),
      organizationId ? this.db.organizations.findById(organizationId) : Promise.resolve(null),
    ]);

    if (!this.apiKeyTableCache) {
      this.apiKeyTableCache = apiKeyTable;
    }

    // Store session + org for the wait=true path to avoid a re-fetch in process
    this.prefetchedSession = session;
    this.prefetchedOrganization = organization;

    // Check session early to fail fast if not found
    if (!session) {
      this.logger.error(
        `Session for sessionId: ${sessionId} not found. The session may have been deleted before the quest was started.`
      );
      return;
    }

    // Get model info (depends on apiKeyTable, so must be sequential)
    let modelInfo = this.modelInfoCache;
    if (!modelInfo && apiKeyTable) {
      modelInfo = await getAvailableModels(apiKeyTable);
      this.modelInfoCache = modelInfo;
    }
    if (!modelInfo) {
      throw new InternalServerError('No available models found');
    }
    const model = modelInfo.find(m => m.id === params.model);
    if (!model) throw new BadRequestError(`Invalid model: "${params.model}" is not available`);
    // A disabled model is still listed (so the picker can show it greyed out) but must never
    // run. Reject it here with a clean message rather than letting the request reach the backend
    // and fail with a raw provider error (e.g. the Anthropic 404 for gated Fable 5). This also
    // covers sessions/agents already pinned to a model that has since been disabled.
    if (model.disabled) {
      throw new BadRequestError(
        `Model "${model.id}" is currently unavailable${model.disabledReason ? `: ${model.disabledReason}` : ''}`
      );
    }

    // Start sessions.update early (will await later in parallel with admin settings)
    const sessionUpdatePromise = this.db.sessions.update({
      id: sessionId,
      lastUsedModel: model.id,
      lastUpdated: now,
      updatedAt: now,
    });

    // Initialize promptMeta for this completion attempt.
    const promptMeta: Partial<PromptMeta> = {
      model: {
        name: model.id,
        type: model?.type as 'text' | 'image' | undefined,
        backend: model?.backend,
        contextWindow: model?.contextWindow,
        maxTokens: model?.max_tokens,
        canStream: model?.can_stream,
        canThink: model?.can_think,
        supportsVision: model?.supportsVision,
        supportsTools: model?.supportsTools,
        supportsImageVariation: model?.supportsImageVariation,
        supportsSafetyTolerance: model?.supportsSafetyTolerance,
        trainingCutoff: model?.trainingCutoff,
        parameters: {
          temperature: params.temperature,
          topP: params.top_p,
          maxTokens: params.max_tokens,
          presencePenalty: params.presence_penalty,
          frequencyPenalty: params.frequency_penalty,
          logitBias: params.logit_bias || undefined,
          stream: params.stream,
        },
      },
      session: {
        id: sessionId,
        userId,
        organizationId: organizationId || undefined,
        projectId: projectId,
        agentId: session.agentIds?.[0],
        agentName: session.agentIds?.[0] ? `Agent ${session.agentIds[0]}` : undefined,
      },
      context: {
        knowledgeBaseEntries: fabFileIds,
        requestedHistoryCount: historyCount,
        messageHistoryLength: 0,
        totalMessageCount: 0,
        attachedFiles: messageFileIds.map(fileId => ({ id: fileId })),
        systemPrompt: message,
        userPrompt: message,
        conversationContext: [], // messageHistory is not in scope here
      },
      performance: {
        totalResponseTime: 0,
        contextRetrievalTime: 0,
        modelInferenceTime: 0,
        streamingPerformance: {
          chunkCount: 0,
          totalStreamTime: 0,
          totalChars: 0,
          charsPerSecond: 0,
        },
        featureExecutionTimes: {},
        databaseOperationTimes: {},
      },
      executionTracking: {
        steps: [],
        currentStep: 'initialization',
        completedSteps: [],
        failedSteps: [],
      },
      // Seed the status log with request-lifecycle timestamps not captured
      // elsewhere. The queue-processed start is the existing "Processing your
      // request..." entry (ChatCompletionProcess), so it is intentionally NOT
      // duplicated here. `now` is the backend-receive time (same value used for
      // quest.timestamp), reused not re-stamped. The client-submit time rides in
      // on the request payload (`clientSubmittedAt`).
      statusLog: [
        ...(body.clientSubmittedAt
          ? [{ status: 'Submitted from client', timestamp: new Date(body.clientSubmittedAt) }]
          : []),
        { status: 'Received by backend', timestamp: now },
      ],
    };

    // Parallelize independent operations: quest ops + admin settings + session update
    const [quest, defaultEmbeddingModel, modelConfigurations] = await Promise.all([
      // Quest creation/update
      questId
        ? this.db.quests.findById(questId).then(async q => {
            if (!q) {
              this.logger.warn(
                `Quest not found for questId: ${questId}. Quest may have been deleted before the quest was started.`
              );
              return null;
            }
            // Retry path: clear prior replies and images.
            q.type = 'message';
            q.reply = null;
            q.replies = [];
            q.questMasterReply = null;
            q.images = [];
            q.prompt = message;
            q.fabFileIds = messageFileIds || []; // ONLY message files
            q.timestamp = now;
            q.status = 'running';
            q.promptMeta = promptMeta;
            q.agentIds = session.agentIds || [];
            await this.db.quests.update(q);
            return q;
          })
        : this.db.quests.create({
            sessionId,
            prompt: message,
            fabFileIds: messageFileIds || [], // ONLY message files
            type: 'message' as const,
            timestamp: now,
            replies: [],
            status: 'running',
            promptMeta,
            agentIds: session.agentIds || [],
          }),

      // Admin settings fetches
      this.db.adminSettings.getSettingsValue('defaultEmbeddingModel'),
      this.modelConfigurationsCache || this.getModelConfigurations(),

      // Session update (fire-and-forget but ensure completion)
      sessionUpdatePromise,
    ]);

    if (!this.modelConfigurationsCache && modelConfigurations) {
      this.modelConfigurationsCache = modelConfigurations;
    }

    if (!quest) return;

    try {
      if (!defaultEmbeddingModel || !isSupportedEmbeddingModel(defaultEmbeddingModel)) {
        throw new InternalServerError('Default embedding model not found or not supported');
      }
      const originalModel = params?.model;

      // Check if primary model is accessible
      const modelToUse = originalModel;

      if (modelConfigurations.length > 0) {
        const primaryModelConfig = modelConfigurations.find(config => config.id === originalModel);
        if (primaryModelConfig) {
          // Entitlement-aware admission: a tag-less subscriber can reach an
          // entitlement-gated model via their resolved keys. Fail-safe to [].
          // Only resolve when keys can change the outcome - skip the DB lookup
          // for admins (always allowed) and for models with no allowedEntitlements
          // (tag-only), keeping the entitlement branch inert.
          const isAdmin = this.user.isAdmin || false;
          const needsEntitlements = !isAdmin && (primaryModelConfig.allowedEntitlements?.length ?? 0) > 0;
          const entitlementKeys = needsEntitlements ? await this.resolveEntitlementKeys() : [];
          const hasUserAccess = isModelAccessible(primaryModelConfig, this.user.tags || [], isAdmin, entitlementKeys);

          if (!primaryModelConfig.enabled || !hasUserAccess) {
            this.logger.error(`Primary model ${originalModel} is not accessible and no fallback available`);
            throw new ForbiddenError(`Model "${originalModel}" is not accessible and no fallback available`);
          }
        }
      }

      let currentEmbeddingModel = embeddingModel;
      if (!currentEmbeddingModel) {
        currentEmbeddingModel = defaultEmbeddingModel;
      }
      const builtInTools = filterBuiltInTools(tools);
      const queryComplexity = classifyQueryComplexity(
        message || '',
        fabFileIds || [],
        messageFileIds || [],
        builtInTools,
        researchMode,
        session.agentIds || []
      );

      this.logger.info(`🚀🚀🚀🚀🚀🚀🚀 [RapidReply] Query complexity: ${queryComplexity}`);

      this.questStartParams = QuestStartBodySchema.parse({
        userId,
        questId: quest.id,
        message,
        messageFileIds,
        historyCount,
        fabFileIds,
        params,
        dashboardParams,
        enableQuestMaster,
        enableMementos,
        enableArtifacts,
        enableAgents,
        enableLattice,
        promptMeta: PromptMetaZodSchema.parse(quest.promptMeta),
        sessionId: session.id,
        tools,
        mcpServers,
        projectId,
        organizationId,
        questMaster,
        toolPromptId,
        researchMode,
        fallbackModel,
        model: modelToUse,
        embeddingModel: currentEmbeddingModel,
        queryComplexity,
        imageConfig,
        deepResearchConfig,
        extraContextMessages,
        allowedAgents,
        enableSlackTools,
      });

      if (this.invokeLambda && this.questStartParams) {
        this.logger.info('🌍 [SERVER] invokeLambda start:', new Date().toISOString());
        await this.invokeLambda(this.questStartParams);
      } else {
        throw new InternalServerError('No invokeLambda function provided');
      }
    } catch (error) {
      let errorMessage = `Something went wrong. Please try again.`;
      if (isZodError(error)) {
        errorMessage = fromZodError(error).message;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      quest.promptMeta = {
        ...quest.promptMeta,
        promptErrors: [errorMessage],
      };

      quest.type = 'error';
      quest.reply = errorMessage;
      await this.db.quests.update(quest);
    }
    return quest;
  }

  private getModelConfigurations = async (): Promise<LLMModelConfig[]> => {
    try {
      const setting = await this.db.adminSettings.findOne({ settingName: 'llmModelConfigurations' });
      const configs = setting?.settingValue;

      if (Array.isArray(configs)) {
        return configs as LLMModelConfig[];
      }

      return [];
    } catch (error) {
      console.error('Failed to fetch model configurations:', error);
      return [];
    }
  };
}
