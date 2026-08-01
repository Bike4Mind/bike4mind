import mongoose, { Model, Schema } from 'mongoose';
import { IChatHistoryItemRepository, IChatHistoryItemDocument, PromptMeta } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

export interface IChatHistoryItemModel extends Model<IChatHistoryItemDocument> {}

// PromptMetaSchema must cover every path in PromptMetaZodSchema (@bike4mind/common), minus a
// short deliberate exclusion list. Mongoose runs strict, so an undeclared subpath is dropped in
// silence on both save() and the findOneAndUpdate + $set path production actually uses.
// PromptMetaSchema.parity.test.ts fails CI on any new drift; add the declaration there and here
// in one commit, or add the path to that test's INTENTIONALLY_NOT_PERSISTED with a reason.
//
// Each of these is its own Schema, not an inline object, so the parent can set
// `default: undefined` and keep an unwritten field ABSENT. An inline nested object containing an
// array materializes on every document, and clients test these for presence.
//
// None of them constrain a string field with `enum`. Writers here outrun their declared unions
// (ModelInfo['type'] has a member the promptMeta union does not), and BaseRepository.create runs
// validators, so an enum would turn a field that used to be dropped in silence into a thrown
// quest-creation. Zod remains the contract; this schema's job is to not lose the value.
const subSchema = (definition: Record<string, unknown>) => new Schema(definition, { _id: false });

const MessageTruncationSchema = subSchema({
  wasTruncated: { type: Boolean, required: false },
  originalMessageCount: { type: Number, required: false },
  truncatedMessageCount: { type: Number, required: false },
  truncationMethod: { type: String, required: false },
  removedMessages: {
    type: [{ role: { type: String }, tokens: { type: Number }, priority: { type: Number } }],
    required: false,
    default: undefined,
  },
});

// `content` is deliberately absent - see the exclusion note on the context path below.
const SystemPromptSourceSchema = subSchema({
  fileId: { type: String, required: false },
  fileName: { type: String, required: false },
  source: { type: String, required: false },
  priority: { type: Number, required: false },
  enabled: { type: Boolean, required: false },
});

const ArtifactSchema = subSchema({
  // No enum: writers emit internal artifact types and can fall back to a raw MIME string.
  // Kept in sync with PromptMetaArtifactSchema, which is deliberately open for the same reason.
  type: { type: String, required: false },
  content: { type: String, required: false },
  metadata: { type: mongoose.Schema.Types.Mixed, required: false },
  timestamp: { type: Date, required: false },
});

const ToolHealthSchema = subSchema({
  toolName: { type: String, required: false },
  available: { type: Boolean, required: false },
  failureCount: { type: Number, required: false },
  lastError: { type: String, required: false },
  lastChecked: { type: Date, required: false },
  lastExecutionTime: { type: Number, required: false },
  successRate: { type: Number, required: false },
});

const ExecutionTrackingSchema = subSchema({
  steps: {
    type: [
      subSchema({
        name: { type: String, required: false },
        status: { type: String, required: false },
        startTime: { type: Date, required: false },
        endTime: { type: Date, required: false },
        result: { type: String, required: false },
        error: { type: String, required: false },
      }),
    ],
    required: false,
    default: undefined,
  },
  currentStep: { type: String, required: false },
  completedSteps: { type: [String], required: false, default: undefined },
  failedSteps: { type: [String], required: false, default: undefined },
});

// Nothing writes humanReview today. Declared anyway so the shape is pinned and the parity guard
// stays satisfied; do not go looking for the writer.
const HumanReviewSchema = subSchema({
  required: { type: Boolean, required: false },
  approved: { type: Boolean, required: false },
  comments: { type: String, required: false },
  modifications: { type: String, required: false },
  reviewedBy: { type: String, required: false },
  reviewedAt: { type: Date, required: false },
});

// The artifact-elision verdict. Its own sub-Schema (via subSchema, like the rest) so the parent can
// set `default: undefined` and keep "no elision detected" as an ABSENT field - the client reads mere
// presence as the server verdict (`!!promptMeta?.suspectedElision`), and an inline object with an
// array would materialize `{ details: [] }` on every quest and banner every artifact ever rendered.
// No `enum` on `confidence`, matching the block's rule above: BaseRepository.create runs validators,
// so an enum would throw on quest creation rather than drop silently, and this path must never eat a
// completed reply. Zod's `suspectedElision` is the contract that constrains it to 'high' | 'low'.
const SuspectedElisionSchema = subSchema({
  confidence: { type: String, required: false },
  signalCount: { type: Number, required: false },
  details: { type: [String], required: false, default: undefined },
});

export const PromptMetaSchema = new Schema<PromptMeta>(
  {
    model: {
      name: { type: String, required: false },
      type: { type: String, required: false },
      backend: { type: String, required: false },
      contextWindow: { type: Number, required: false },
      maxTokens: { type: Number, required: false },
      canStream: { type: Boolean, required: false },
      canThink: { type: Boolean, required: false },
      supportsVision: { type: Boolean, required: false },
      supportsTools: { type: Boolean, required: false },
      supportsImageVariation: { type: Boolean, required: false },
      supportsSafetyTolerance: { type: Boolean, required: false },
      trainingCutoff: { type: String, required: false },
      parameters: {
        temperature: { type: Number, required: false },
        topP: { type: Number, required: false },
        maxTokens: { type: Number, required: false },
        presencePenalty: { type: Number, required: false },
        frequencyPenalty: { type: Number, required: false },
        // Mixed rather than Map: the Zod type is Record<string, number>, and a Map would surface
        // to callers as a Map instance.
        logitBias: { type: mongoose.Schema.Types.Mixed, required: false },
        stream: { type: Boolean, required: false },
        // Image and video generation parameters.
        n: { type: Number, required: false },
        quality: { type: String, required: false },
        style: { type: String, required: false },
        size: { type: String, required: false },
        width: { type: Number, required: false },
        height: { type: Number, required: false },
        aspect_ratio: { type: String, required: false },
        safety_tolerance: { type: Number, required: false },
        prompt_upsampling: { type: Boolean, required: false },
        seed: { type: Number, required: false },
        output_format: { type: String, required: false },
        response_format: { type: String, required: false },
        seconds: { type: Number, required: false },
        model: { type: String, required: false },
      },
    },
    tokenUsage: {
      inputTokens: { type: Number, required: false },
      outputTokens: { type: Number, required: false },
      totalTokens: { type: Number, required: false },
      actualInputTokens: { type: Number, required: false },
      actualOutputTokens: { type: Number, required: false },
      actualTotalTokens: { type: Number, required: false },
      // Billing audit fields. Without these declared, Mongoose strict mode silently
      // strips them from the persisted doc (the Zod PromptMetaTokenUsageSchema allows
      // them, but the runtime write goes through this subschema). cacheReadInputTokens
      // is the capped cache-read count used for the discount; estimatedCost /
      // creditsUsed are the billed amounts (previously computed but not persisted).
      cacheReadInputTokens: { type: Number, required: false },
      estimatedCost: { type: Number, required: false },
      creditsUsed: { type: Number, required: false },
      settledBasis: { type: String, enum: ['provider', 'local'], required: false },
    },
    // Stays a nested path literal rather than a sub-Schema. Both strip identically under strict,
    // so converting buys nothing, and ChatCompletionProcess assigns through
    // `quest.promptMeta!.context!.x = ...`, which depends on the path being auto-created.
    //
    // NOT declared here, and must not be: systemPrompt, userPrompt, conversationContext,
    // extraContextMessages, and systemPromptSources[].content. Those carry prompt and
    // conversation CONTENT, and the quest document is serialized to the client on many read
    // paths, so persisting them leaks a server-owned prompt. See the note at the
    // extraContextMessages write site in ChatCompletionProcess.
    context: {
      attachedFiles: [
        {
          id: { type: String, required: false },
          name: { type: String, required: false },
          type: { type: String, required: false },
          size: { type: Number, required: false },
          mimeType: { type: String, required: false },
          lastModified: { type: Date, required: false },
        },
      ],
      knowledgeBaseEntries: [{ type: String, required: false }],
      messageHistoryLength: { type: Number, required: false },
      requestedHistoryCount: { type: Number, required: false },
      totalMessageCount: { type: Number, required: false },
      mementoCount: { type: Number, required: false },
      mementoIds: [{ type: String, required: false }],
      systemPromptSources: { type: [SystemPromptSourceSchema], required: false, default: undefined },
      dedupedSystemPrompts: { type: [String], required: false, default: undefined },
      totalSystemPromptCount: { type: Number, required: false },
      duplicateSystemPromptCount: { type: Number, required: false },
      sessionFileIds: { type: [String], required: false, default: undefined },
      messageFileIds: { type: [String], required: false, default: undefined },
      globalSystemFileIds: { type: [String], required: false, default: undefined },
      userSystemFileIds: { type: [String], required: false, default: undefined },
      projectSystemFileIds: { type: [String], required: false, default: undefined },
      messageTruncation: { type: MessageTruncationSchema, required: false, default: undefined },
      tokensBySource: {
        systemPrompts: { type: Number, required: false },
        conversationHistory: { type: Number, required: false },
        mementos: { type: Number, required: false },
        fabFiles: { type: Number, required: false },
        urlContent: { type: Number, required: false },
        toolSchemas: { type: Number, required: false },
        userPrompt: { type: Number, required: false },
      },
      // Assembled context-window usage for the completed turn. Like the billing
      // audit fields above, this must be declared or Mongoose strict mode silently
      // strips it on save (it is set in ChatCompletionProcess and read by the
      // client's useSessionContextUsage to surface effective context size).
      contextWindowUsage: {
        contextLimit: { type: Number, required: false },
        maxOutputTokens: { type: Number, required: false },
        safeMaxInputTokens: { type: Number, required: false },
        actualInputTokens: { type: Number, required: false },
        bufferTokens: { type: Number, required: false },
        utilizationPercentage: { type: Number, required: false },
        overflowDetected: { type: Boolean, required: false },
        overflowAmount: { type: Number, required: false },
        verbatimTurnsExcluded: { type: Number, required: false },
      },
    },
    functionCalls: [
      {
        name: { type: String, required: false },
        parameters: { type: mongoose.Schema.Types.Mixed, required: false },
        returnValue: { type: String, required: false },
        creditsUsed: { type: Number, required: false },
        executionTime: { type: Number, required: false },
        success: { type: Boolean, required: false },
        error: { type: String, required: false },
        // Provider tool-call id, required to pair a replayed tool_use with its tool_result.
        // Dropping it is what kept the replay path in @bike4mind/utils unreachable.
        id: { type: String, required: false },
      },
    ],
    performance: {
      totalResponseTime: { type: Number, required: false },
      contextRetrievalTime: { type: Number, required: false },
      modelInferenceTime: { type: Number, required: false },
      firstTokenTime: { type: Number, required: false },
      // Posted back by the client after it renders the first token (quests/[id]/client-timing).
      clientFirstTokenTime: { type: Number, required: false },
      streamingPerformance: {
        chunkCount: { type: Number, required: false },
        totalStreamTime: { type: Number, required: false },
        totalChars: { type: Number, required: false },
        charsPerSecond: { type: Number, required: false },
      },
      featureExecutionTimes: { type: Map, of: Number, required: false },
      databaseOperationTimes: { type: Map, of: Number, required: false },
      phases: { type: Map, of: Number, required: false },
    },
    session: {
      id: { type: String, required: true },
      userId: { type: String, required: true },
      organizationId: { type: String, required: false },
      projectId: { type: String, required: false },
      agentId: { type: String, required: false },
      agentName: { type: String, required: false },
    },
    prompt: { type: String, required: false },
    questId: { type: String, required: false },
    promptId: { type: String, required: false },
    replyIds: [{ type: String, required: false }],
    generatedImageReferences: [{ type: String, required: false }],
    promptErrors: [{ type: String, required: false }],
    warnings: [{ type: String, required: false }],
    // ISO 8601 string, not a Date - the Zod field is z.string().
    generatedAt: { type: String, required: false },
    finishReason: { type: String, required: false },
    artifacts: { type: [ArtifactSchema], required: false, default: undefined },
    toolHealth: { type: [ToolHealthSchema], required: false, default: undefined },
    executionTracking: { type: ExecutionTrackingSchema, required: false, default: undefined },
    humanReview: { type: HumanReviewSchema, required: false, default: undefined },
    // Suspected-elision verdict from the artifact scan. MUST be declared or strict mode drops it on
    // save; sub-Schema with `default: undefined` keeps an unwritten verdict ABSENT (see the schema
    // definition above for why presence matters to the client).
    suspectedElision: { type: SuspectedElisionSchema, required: false, default: undefined },
    statusLog: [{ status: { type: String, required: true }, timestamp: { type: Date, required: true } }],
    // Citable sources referenced in AI responses (from web_search, deep_research, RAG, MCP)
    citables: [
      {
        id: { type: String, required: true },
        type: { type: String, enum: ['web_url', 'document', 'dataset', 'mcp'], required: true },
        title: { type: String, required: true },
        url: { type: String, required: false },
        description: { type: String, required: false },
        timestamp: { type: String, required: false },
        author: { type: String, required: false },
        status: { type: String, enum: ['pending', 'processing', 'complete', 'error'], required: false },
        metadata: { type: mongoose.Schema.Types.Mixed, required: false },
      },
    ],
    // Context telemetry for debugging and monitoring (privacy-first, no PII)
    // Uses Mixed type as the structure is validated by Zod schema before assignment
    contextTelemetry: { type: mongoose.Schema.Types.Mixed, required: false },
  },
  { _id: false }
);

export const ChatHistoryItemSchema = new Schema<IChatHistoryItemDocument>(
  {
    sessionId: { type: String, required: true },
    conversationItemId: { type: String, required: false },
    openaiMessageId: { type: String, required: false },
    claudeMessageId: { type: String, required: false },
    timestamp: { type: Date, required: true },
    type: { type: String, required: true },
    prompt: { type: String, required: true },
    fabFileIds: { type: [String], required: false },
    agentIds: { type: [String], required: false },
    reply: { type: String, required: false },
    replies: { type: [String], required: false },
    // Structured content blocks for assistant replies (tool_use, thinking, etc.)
    // Preserves full message structure for Anthropic API tool pairing
    structuredReplies: {
      type: [
        {
          role: { type: String, required: true },
          content: { type: [Schema.Types.Mixed], required: true },
        },
      ],
      required: false,
    },
    // Tool results corresponding to tool_use blocks in structuredReplies
    // Stored separately for proper message reconstruction with correct ordering
    toolResults: {
      type: [
        {
          tool_use_id: { type: String, required: true },
          content: { type: String, required: true },
          is_error: { type: Boolean, required: false },
        },
      ],
      required: false,
    },
    questMasterReply: { type: String, required: false },
    questMasterPlanId: { type: String, required: false },
    // Set when this Quest was created from an agent_execute terminal path
    // (see `persistRunAsQuest` in agentExecutor.ts). Points to the originating
    // AgentExecution doc so the chat-history disclosure can lazy-load the
    // iteration trace on demand.
    agentExecutionId: { type: String, required: false },
    // Provenance of the routing decision that produced this quest.
    // Drives the `AutoRouteBadge` rendering above auto-routed responses
    // (classifier- or rule-based complexity-routed).
    routingSource: {
      type: String,
      enum: ['mention', 'agent_literal', 'toggle', 'classifier', 'user-default', 'complexity'],
      required: false,
    },
    images: { type: [String], required: false },
    videos: { type: [String], required: false },
    oob: { type: String, required: false },
    promptMeta: { type: PromptMetaSchema, required: false },
    status: { type: String, required: false },
    // Machine-readable classifier for `type: 'error'` quests (e.g. 'insufficient_credits'),
    // set server-side so the client can render a targeted error state. Declared so Mongoose
    // strict mode persists it (otherwise the error UI would not survive a reload).
    errorCode: { type: String, required: false },
    creditsUsed: { type: Number, required: false },
    pinned: { type: Boolean, required: false, default: false },
    researchModeResults: [
      {
        configurationId: { type: String, required: true },
        success: { type: Boolean, required: true },
        response: { type: String, required: false },
        error: { type: String, required: false },
        completionInfo: {
          inputTokens: { type: Number, required: false },
          outputTokens: { type: Number, required: false },
        },
      },
    ],
    deepResearchState: {
      type: {
        findings: [
          {
            text: { type: String, required: true },
            source: { type: String, required: true },
          },
        ],
        activities: [
          {
            type: {
              type: String,
              enum: ['search', 'extract', 'analyze', 'reasoning', 'synthesis', 'thought'],
              required: true,
            },
            status: { type: String, enum: ['pending', 'complete', 'error'], required: true },
            message: { type: String, required: true },
            timestamp: { type: String, required: true },
            depth: { type: Number, required: true },
          },
        ],
        sources: [
          {
            url: { type: String, required: true },
            title: { type: String, required: true },
            description: { type: String, required: true },
            status: { type: String, enum: ['found', 'analyzing', 'complete', 'error'], required: true },
            timestamp: { type: String, required: true },
            type: { type: String, required: true },
          },
        ],
        depth: { type: Number, required: false },
        completed: { type: Boolean, required: false },
        nextSearchQueries: [{ type: String }],
        completedSteps: { type: Number, required: false },
        totalExpectedSteps: { type: Number, required: false },
        topic: { type: String, required: false },
        startTime: { type: Number, required: false },
        endTime: { type: Number, required: false },
      },
      required: false,
    },
    promptEnhancement: {
      originalPrompt: { type: String, required: false },
      enhancedPrompt: { type: String, required: false },
      promptWasEnhanced: { type: Boolean, required: false },
      intent: { type: String, enum: ['fresh', 'continuation'], required: false },
    },
    // Pre-computed embedding for semantic search (generated by Zen Garden Spider)
    embedding: {
      vector: { type: [Number], required: false },
      model: { type: String, required: false },
      generatedAt: { type: Date, required: false },
      contentHash: { type: String, required: false },
    },
    // Pending action for Slack/Web button-based confirmation flow
    // Stores structured data from MCP tool results for direct execution on confirm
    pendingAction: {
      type: {
        tool: { type: String, required: true },
        params: { type: Schema.Types.Mixed, required: true },
        ts: { type: Number, required: true },
      },
      required: false,
    },
    // Slack notification info for async message editing
    // Used by Quest Processor to edit status message with final response
    slackNotification: {
      type: {
        workspaceId: { type: String, required: true },
        channelId: { type: String, required: true },
        threadTs: { type: String, required: true },
        messageTs: { type: String, required: true },
        isPaintCommand: { type: Boolean, required: false },
      },
      required: false,
    },
    // Attachment list for interactive download buttons (Slack and web UI)
    // Stores attachment metadata from MCP list tools for button generation
    attachmentList: {
      type: {
        source: { type: String, enum: ['jira', 'confluence'], required: true },
        issueKey: { type: String, required: false }, // For Jira
        pageId: { type: String, required: false }, // For Confluence
        pageTitle: { type: String, required: false }, // For Confluence (user-friendly display)
        attachments: [
          {
            id: { type: String, required: true },
            filename: { type: String, required: true },
            emoji: { type: String, required: true },
            sizeFormatted: { type: String, required: true },
            mimeType: { type: String, required: false },
            author: { type: String, required: false }, // Who uploaded the attachment
          },
        ],
      },
      required: false,
    },
    // Navigation intents from navigate_view tool - inline action buttons in chat
    navigationIntents: {
      type: [
        {
          viewId: { type: String, required: true },
          label: { type: String, required: true },
          description: { type: String, required: true },
          navigationType: { type: String, enum: ['route', 'tab', 'action'], required: true },
          target: { type: String, required: true },
          reason: { type: String, required: true },
        },
      ],
      required: false,
    },
    // Generalized UI side-effects extracted from tool __uiSideEffect sentinels
    uiSideEffects: {
      type: [
        {
          type: { type: String, required: true },
          payload: { type: Schema.Types.Mixed, required: true },
        },
      ],
      required: false,
    },
    // Jupyter notebook execution state
    jupyterNotebook: {
      type: {
        status: {
          type: String,
          enum: ['pending', 'generating', 'executing', 'completed', 'failed'],
          required: true,
        },
        notebookPath: { type: String, required: false },
        fabFileId: { type: String, required: false }, // Stored executed notebook
        kernelName: { type: String, required: false },
        cellCount: { type: Number, required: false },
        executedCells: { type: Number, required: false },
        lastError: { type: String, required: false },
        retryCount: { type: Number, required: false },
        startedAt: { type: Date, required: false },
        completedAt: { type: Date, required: false },
      },
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: function (_, ret: Record<string, unknown>) {
        delete ret._id;
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

class QuestRepository extends BaseRepository<IChatHistoryItemDocument> implements IChatHistoryItemRepository {
  ctx: mongoose.mongo.ClientSession | null;

  constructor(private questModel: IChatHistoryItemModel) {
    super(questModel);
    this.ctx = null;
  }

  async findBySessionIdAndId(sessionId: string, id: string) {
    const result = await this.model.findOne({ sessionId, _id: id });
    if (!result) return null;
    const doc = result.toJSON();
    return { ...doc } as IChatHistoryItemDocument;
  }

  async findAllBySessionId(sessionId: string) {
    const query = this.model.find({ sessionId }).sort({ timestamp: -1 });
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation. `ctx` defaults to `null`, so an
    // unconditional `.session(this.ctx)` would silently defeat ALS for every caller.
    if (this.ctx) {
      query.session(this.ctx);
    }
    const result = await query;
    return result.map(d => {
      const doc = d.toJSON();
      return { ...doc } as IChatHistoryItemDocument;
    });
  }

  /**
   * One page of a session's turns, oldest-first by default - the read shape a
   * support view needs (a long notebook must not be loaded whole). Projects only
   * the conversation fields, so bulk payloads like `structuredReplies` and
   * `deepResearchState` stay out of the response. `hasMore` comes from fetching
   * one extra row, matching the pagination contract used by the chat endpoints.
   *
   * Sorts on `_id` as a tiebreaker: `timestamp` is required but NOT unique, and
   * with `.skip()` an ambiguous order lets turns sharing a millisecond repeat
   * across a page boundary or be skipped entirely - which would also make the
   * audited page/returned counts an inaccurate record of what was read.
   */
  async findPageBySessionId(
    sessionId: string,
    options: { limit: number; page: number; sort?: 'asc' | 'desc' }
  ): Promise<{ data: IChatHistoryItemDocument[]; hasMore: boolean }> {
    const { limit, page, sort = 'asc' } = options;
    const result = await this.model
      .find({ sessionId, deletedAt: null })
      .select('sessionId timestamp type status errorCode prompt reply replies fabFileIds images promptMeta creditsUsed')
      .sort({ timestamp: sort, _id: sort })
      .skip(limit * (page - 1))
      .limit(limit + 1);

    const hasMore = result.length > limit;
    const rows = hasMore ? result.slice(0, limit) : result;
    return {
      data: rows.map(d => ({ ...d.toJSON() }) as IChatHistoryItemDocument),
      hasMore,
    };
  }

  async findAllBySessionIdAndLessThanOrEqualToTimestamp(sessionId: string, timestamp: Date) {
    const query = this.model.find({ sessionId, timestamp: { $lte: timestamp } }).sort({ timestamp: -1 });
    // See `findAllBySessionId` above.
    if (this.ctx) {
      query.session(this.ctx);
    }
    const result = await query;
    return result.map(d => {
      const doc = d.toJSON();
      return { ...doc } as IChatHistoryItemDocument;
    });
  }

  async findAllBySessionIdAndGreaterThanOrEqualToTimestamp(sessionId: string, timestamp: Date) {
    const query = this.model.find({ sessionId, timestamp: { $gte: timestamp } }).sort({ timestamp: -1 });
    // See `findAllBySessionId` above.
    if (this.ctx) {
      query.session(this.ctx);
    }
    const result = await query;
    return result.map(d => {
      const doc = d.toJSON();
      return { ...doc } as IChatHistoryItemDocument;
    });
  }

  async getMostRecentChatHistory(sessionId: string, limit: number) {
    // DEFENSE-IN-DEPTH: Explicit deletedAt filter ensures soft-deleted messages are excluded
    // even though Mongoose middleware should handle this.
    const result = await this.model
      .find({ sessionId, deletedAt: null })
      // Include structuredReplies, toolResults, promptMeta for tool pairing reconstruction
      // Include jupyterNotebook for notebook execution state display
      // Include fabFileIds so image generation can use an image the user attached to an
      // earlier turn as an input image (see ImageGenerationService.selectInputImage).
      .select(
        'sessionId timestamp type prompt reply replies structuredReplies toolResults promptMeta images fabFileIds researchModeResults jupyterNotebook oob _id'
      )
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    // Because we're using .lean(), we need to convert the _id to a string. Virtuals like id are not included when using .lean().
    // Filter out documents with null _id to prevent toString() errors
    return result
      .filter(doc => doc._id != null)
      .map(doc => ({ ...doc, id: doc._id.toString() }) as IChatHistoryItemDocument);
  }

  async findByIdWithStatus(id: string) {
    const result = await this.model.findById(id).select('_id status');
    if (!result) return null;
    return { ...result.toObject(), id: result._id.toString() } as Pick<IChatHistoryItemDocument, 'id' | 'status'>;
  }

  async upsertBySessionIdAndConversationItemId(
    sessionId: string,
    conversationItemId: string,
    data: Partial<IChatHistoryItemDocument>
  ) {
    return this.model.findOneAndUpdate({ sessionId, conversationItemId }, { $set: data }, { upsert: true, new: true });
  }

  // Flag a quest as stopped so an in-flight ChatCompletionProcess cancellation
  // watcher aborts the underlying LLM request. Used when a voice turn's client
  // (ElevenLabs) disconnects mid-stream so we don't keep burning tokens.
  async markStopped(id: string) {
    await this.model.findOneAndUpdate(
      { _id: id },
      { status: 'stopped', statusMessage: 'Voice turn cancelled (client disconnected)' }
    );
  }

  /**
   * Append generated-file names to a Quest's `images` array, keyed by the agent execution
   * that produced them. Uses `$addToSet` so concurrent writers - the parent run and any
   * subagents, each in its own Lambda - accumulate into the same array instead of clobbering
   * each other. No-op if no Quest matches (best-effort; the files also persist as FabFiles).
   */
  async addImagesByAgentExecutionId(agentExecutionId: string, images: string[]) {
    if (!images.length) return;
    await this.model.updateOne({ agentExecutionId }, { $addToSet: { images: { $each: images } } });
  }

  // Cheap existence check (Mongo `exists` returns just the `_id` of the first
  // match). The voice proxy uses this to decide whether to emit an ElevenLabs
  // buffer chunk on the very first turn of a fresh session (no prior quests).
  // No `deletedAt` filter on purpose: a soft-deleted prior turn still means the
  // session has been used before, so it should not count as brand-new.
  async existsBySessionId(sessionId: string): Promise<boolean> {
    return !!(await this.model.exists({ sessionId }));
  }

  // Returns the most recent quest in the session that has no reply yet, or
  // null if every quest already has one (or none exist).
  async findLatestUnrepliedMessage(sessionId: string) {
    const result = await this.model
      .findOne({
        sessionId,
        $and: [
          { $or: [{ replies: { $exists: false } }, { replies: { $size: 0 } }] },
          { $or: [{ reply: { $exists: false } }, { reply: '' }] },
        ],
      })
      .sort({ timestamp: -1 });
    if (!result) return null;
    return { ...result.toJSON() } as IChatHistoryItemDocument;
  }
}

// Initialize the model and apply plugins
function initializeQuestModel() {
  try {
    ChatHistoryItemSchema.plugin(softDeletePlugin);

    // Optimized indexes for common query patterns

    // Primary index for getMostRecentChatHistory query: { sessionId }.sort({ timestamp: -1 })
    ChatHistoryItemSchema.index({ sessionId: 1, timestamp: -1 }, { name: 'sessionId_timestamp_desc' });

    // Backup index for soft delete compatibility
    ChatHistoryItemSchema.index(
      { deletedAt: 1, sessionId: 1, timestamp: -1 },
      { name: 'deletedAt_sessionId_timestamp_desc' }
    );

    // Index for findBySessionIdAndId operations
    ChatHistoryItemSchema.index({ sessionId: 1, _id: 1 }, { name: 'sessionId_id' });

    // Index for status-based queries (used in cancellation watcher)
    ChatHistoryItemSchema.index({ _id: 1, status: 1 }, { name: 'id_status' });

    // Index for deletedAt and timestamp queries
    ChatHistoryItemSchema.index({ deletedAt: 1, timestamp: -1 }, { name: 'deletedAt_timestamp_desc' });

    // Index for finding messages without embeddings (for Zen Garden grooming)
    ChatHistoryItemSchema.index(
      { sessionId: 1, 'embedding.generatedAt': 1 },
      { name: 'sessionId_embedding_generatedAt', sparse: true }
    );

    // Index for context telemetry baselines aggregation (model+provider+timestamp)
    ChatHistoryItemSchema.index(
      {
        'promptMeta.contextTelemetry.model.modelId': 1,
        'promptMeta.contextTelemetry.model.provider': 1,
        timestamp: -1,
      },
      { name: 'telemetry_model_provider_timestamp', sparse: true }
    );

    // Index for /api/models/stats aggregation: $match { 'promptMeta.model.name': { $exists: true } }
    // followed by $group on the same field
    ChatHistoryItemSchema.index({ 'promptMeta.model.name': 1 }, { name: 'promptMeta_model_name', sparse: true });

    // Index for `persistRunAsQuest` lookup by agentExecutionId on every agent
    // completion. Sparse because most Quests are chat_completion and
    // lack the field - a dense index would waste space on nulls.
    ChatHistoryItemSchema.index({ agentExecutionId: 1 }, { name: 'agentExecutionId', sparse: true });
  } catch (error) {
    // Plugin already applied, ignore error
  }

  return (
    (mongoose.models.Quest as IChatHistoryItemModel) ||
    mongoose.model<IChatHistoryItemDocument, IChatHistoryItemModel>('Quest', ChatHistoryItemSchema)
  );
}

export const Quest = initializeQuestModel();

export const questRepository = new QuestRepository(Quest);
