import { z } from 'zod';
import { ContextTelemetrySchema } from './contextTelemetry';

const PromptMetaModelParametersSchema = z.object({
  // Text generation parameters
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),
  logitBias: z.record(z.string(), z.number()).optional(),
  stream: z.boolean().optional(),

  // Image generation parameters
  n: z.number().optional(), // Number of images
  quality: z.string().optional(),
  style: z.string().optional(),
  size: z.string().optional(), // Image/video size (e.g., "1024x1024", "720x1280")
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  safety_tolerance: z.number().optional(), // BFL safety tolerance
  prompt_upsampling: z.boolean().optional(), // BFL prompt upsampling
  seed: z.number().optional(),
  output_format: z.string().optional(), // Output format (jpeg/png)
  response_format: z.string().optional(), // Response format (url/b64_json)

  // Video generation parameters (Sora)
  seconds: z.number().optional(), // Video duration in seconds (4, 8, or 12)
  model: z.string().optional(), // Video model name
});

const PromptMetaModelSchema = z.object({
  // We're flexible about model name since they'll potentially come from Hugging Face
  // or other public sources
  name: z.string(),
  parameters: PromptMetaModelParametersSchema.optional(),
  type: z.enum(['text', 'image', 'video']).optional(),
  backend: z.string().optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  canStream: z.boolean().optional(),
  canThink: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsImageVariation: z.boolean().optional(),
  supportsSafetyTolerance: z.boolean().optional(),
  trainingCutoff: z.string().optional(),
});

const PromptMetaTokenUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  actualInputTokens: z.number().optional(),
  actualOutputTokens: z.number().optional(),
  actualTotalTokens: z.number().optional(),
  // Billed cache-read count: raw provider value on provider-basis settlement,
  // capped-at-local-input discount value on local fallback.
  cacheReadInputTokens: z.number().optional(),
  // Which basis priced estimatedCost/creditsUsed: provider-reported usage or
  // the local tokenizer estimate (fallback when the provider omits usage).
  settledBasis: z.enum(['provider', 'local']).optional(),
  estimatedCost: z.number().optional(),
  creditsUsed: z.number().optional(),
});

const PromptMetaAttachedFileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  lastModified: z.date().optional(),
});

const SystemPromptSourceSchema = z.object({
  fileId: z.string(),
  fileName: z.string().optional(),
  source: z.enum(['admin', 'user', 'project', 'session', 'hardcoded']),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
  content: z.string().optional(),
});

// Token breakdown by source (shared with contextTelemetry but also stored directly for overflow diagnostics)
const PromptMetaTokensBySourceSchema = z.object({
  systemPrompts: z.number(),
  conversationHistory: z.number(),
  mementos: z.number(),
  fabFiles: z.number(),
  urlContent: z.number(),
  toolSchemas: z.number(),
  userPrompt: z.number(),
});

const PromptMetaContextSchema = z.object({
  attachedFiles: z.array(PromptMetaAttachedFileSchema).optional(),
  knowledgeBaseEntries: z.array(z.string()).optional(),
  messageHistoryLength: z.number().optional(),
  requestedHistoryCount: z.number().optional(),
  totalMessageCount: z.number().optional(),
  mementoCount: z.number().optional(),
  mementoIds: z.array(z.string()).optional(),
  tokensBySource: PromptMetaTokensBySourceSchema.optional(),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().optional(),
  conversationContext: z
    .array(
      z.object({
        role: z.string(),
        content: z.string(),
        timestamp: z.date().optional(),
      })
    )
    .optional(),
  // Extra context messages for external sources
  extraContextMessages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'function', 'tool']),
        content: z.union([z.string(), z.array(z.any())]),
        fabFileIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
  systemPromptSources: z.array(SystemPromptSourceSchema).optional(),
  dedupedSystemPrompts: z.array(z.string()).optional(),
  totalSystemPromptCount: z.number().optional(),
  duplicateSystemPromptCount: z.number().optional(),
  sessionFileIds: z.array(z.string()).optional(),
  messageFileIds: z.array(z.string()).optional(),
  globalSystemFileIds: z.array(z.string()).optional(),
  userSystemFileIds: z.array(z.string()).optional(),
  projectSystemFileIds: z.array(z.string()).optional(),
  // Phase 2: Context window debug fields
  contextWindowUsage: z
    .object({
      contextLimit: z.number(),
      maxOutputTokens: z.number(),
      safeMaxInputTokens: z.number(),
      actualInputTokens: z.number(),
      bufferTokens: z.number(),
      utilizationPercentage: z.number(),
      overflowDetected: z.boolean().optional(),
      overflowAmount: z.number().optional(),
    })
    .optional(),
  // Phase 2: Message truncation tracking
  messageTruncation: z
    .object({
      wasTruncated: z.boolean(),
      originalMessageCount: z.number(),
      truncatedMessageCount: z.number(),
      truncationMethod: z.enum(['priority', 'token-budget', 'history-limit']).optional(),
      removedMessages: z
        .array(
          z.object({
            role: z.string(),
            tokens: z.number(),
            priority: z.number(),
          })
        )
        .optional(),
    })
    .optional(),
});

const PromptMetaFunctionCallSchema = z.object({
  name: z.string().optional(),
  parameters: z.record(z.string(), z.any()).optional(), // z.any() supports arrays, objects, and all JSON types
  returnValue: z.string().optional(),
  executionTime: z.number().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  creditsUsed: z.number().optional(),
  /** Tool use ID for Anthropic API tool pairing */
  id: z.string().optional(),
});

const PromptMetaPerformanceSchema = z.object({
  totalResponseTime: z.number().optional(),
  contextRetrievalTime: z.number().optional(),
  modelInferenceTime: z.number().optional(),
  firstTokenTime: z.number().optional(),
  clientFirstTokenTime: z.number().optional(), // Time from client sending prompt to client rendering first token
  streamingPerformance: z
    .object({
      chunkCount: z.number().optional(),
      totalStreamTime: z.number().optional(),
      totalChars: z.number().optional(),
      charsPerSecond: z.number().optional(),
    })
    .optional(),
  featureExecutionTimes: z.union([z.record(z.string(), z.number()), z.map(z.string(), z.number())]).optional(),
  databaseOperationTimes: z.union([z.record(z.string(), z.number()), z.map(z.string(), z.number())]).optional(),
  phases: z.record(z.string(), z.number()).optional(),
});

const PromptMetaSessionSchema = z.object({
  id: z.string(), // Required as per Mongoose schema
  userId: z.string(), // Required as per Mongoose schema
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
});

const PromptMetaArtifactSchema = z.object({
  type: z.enum(['text', 'image', 'file', 'data']),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.date().optional(),
});

const ToolHealthSchema = z.object({
  toolName: z.string(),
  available: z.boolean(),
  failureCount: z.number(),
  lastError: z.string().optional(),
  lastChecked: z.date().optional(),
  lastExecutionTime: z.number().optional(),
  successRate: z.number().optional(),
});

// Citable Source Schema - tracks sources referenced in AI responses
// Used by web_search, deep_research, RAG, and MCP tools
export const CitableSourceSchema = z.object({
  /** Unique identifier - can be URL, UUID, or composite key */
  id: z.string(),
  /** Source classification for UI rendering */
  type: z.enum(['web_url', 'document', 'dataset', 'mcp']),
  /** Human-readable title/name */
  title: z.string(),
  /** Navigation target (external URL, deep link, or hash route) */
  url: z.string().optional(),
  /** Brief description or excerpt (1-2 sentences) */
  description: z.string().optional(),
  /** ISO 8601 timestamp for freshness indication */
  timestamp: z.string().optional(),
  /** Attribution for non-report sources */
  author: z.string().optional(),
  /** Processing status for real-time updates */
  status: z.enum(['pending', 'processing', 'complete', 'error']).optional(),
  /** Extensibility metadata */
  metadata: z
    .looseObject({
      sourceSystem: z.string().optional(),
      icon: z.string().optional(),
      tags: z.array(z.string()).optional(),
      confidence: z.number().optional(),
      practiceAreas: z.array(z.string()).optional(),
      chunkId: z.string().optional(),
      relevanceScore: z.number().optional(),
      fullContext: z.string().optional(),
    }) // Allow additional properties
    .optional(),
});

// Main PromptMeta Schema
export const PromptMetaZodSchema = z.object({
  model: PromptMetaModelSchema.optional(),
  tokenUsage: PromptMetaTokenUsageSchema.optional(),
  context: PromptMetaContextSchema.optional(),
  functionCalls: z.array(PromptMetaFunctionCallSchema).optional(),
  performance: PromptMetaPerformanceSchema.optional(),
  session: PromptMetaSessionSchema.optional(),
  questId: z.string().optional(),
  /** ISO 8601 timestamp of when this completion's data was finalized (set at completion end). */
  generatedAt: z.string().optional(),
  promptId: z.string().optional(),
  prompt: z.string().optional(),
  replyIds: z.array(z.string()).optional(),
  generatedImageReferences: z.array(z.string()).optional(),
  promptErrors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  /**
   * The provider's reason for ending generation (Anthropic vocabulary:
   * 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'pause_turn').
   * 'max_tokens' signals the response was truncated against the output ceiling,
   * letting the client render a truncated-artifact recovery affordance.
   */
  finishReason: z.string().optional(),
  statusLog: z
    .array(
      z.object({
        status: z.string(),
        timestamp: z.date().or(z.string()), // z.string() is for API params stringify compatibility
      })
    )
    .optional(),
  artifacts: z.array(PromptMetaArtifactSchema).optional(),
  humanReview: z
    .object({
      required: z.boolean().optional(),
      approved: z.boolean().optional(),
      comments: z.string().optional(),
      modifications: z.string().optional(),
      reviewedBy: z.string().optional(),
      reviewedAt: z.date().optional(),
    })
    .optional(),
  executionTracking: z
    .object({
      steps: z
        .array(
          z.object({
            name: z.string(),
            status: z.enum(['pending', 'running', 'completed', 'failed']),
            startTime: z.date().optional(),
            endTime: z.date().optional(),
            result: z.string().optional(),
            error: z.string().optional(),
          })
        )
        .optional(),
      currentStep: z.string().optional(),
      completedSteps: z.array(z.string()).optional(),
      failedSteps: z.array(z.string()).optional(),
    })
    .optional(),
  // Phase 2: Tool health tracking
  toolHealth: z.array(ToolHealthSchema).optional(),
  // Citable sources referenced in AI responses (from web_search, deep_research, RAG, MCP)
  citables: z.array(CitableSourceSchema).optional(),
  // Context telemetry for debugging and monitoring (privacy-first, no PII)
  contextTelemetry: ContextTelemetrySchema.optional(),
});
