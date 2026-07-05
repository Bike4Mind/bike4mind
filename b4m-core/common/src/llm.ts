import { z } from 'zod';
import { ChatCompletionCreateInputSchema, OpenAIImageGenerationInput } from './schemas/openai';
import { b4mLLMTools, B4MLLMTools } from './schemas/llm';

// Re-export LLM tools for external use
export { b4mLLMTools };
export type { B4MLLMTools };

export const DashboardParamsSchema = z.object({
  dashboardDataSources: z.array(
    z.object({
      sourceName: z.string(),
      data: z.any(),
    })
  ),
  promptName: z.string().optional(),
});

export const QuestMasterParamsSchema = z.object({
  questMasterPlanId: z.string(),
  questId: z.string(),
  subQuestId: z.string(),
});

export const ResearchModeConfigurationSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  model: z.string(),
  parameters: z.object({
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
    topP: z.number().optional(),
    presencePenalty: z.number().optional(),
    frequencyPenalty: z.number().optional(),
  }),
  label: z.string().optional(),
});

export const ResearchModeParamsSchema = z.object({
  enabled: z.boolean(),
  configurations: z.array(ResearchModeConfigurationSchema).max(4),
});

/**
 * Classifies a user's image-generation prompt as either a fresh request
 * or a continuation of the most recent generated image (refine/vary/edit).
 * Used to gate whether the prior session image is fed back as input.
 */
export const PromptIntentSchema = z.enum(['fresh', 'continuation']);
export type PromptIntent = z.infer<typeof PromptIntentSchema>;

export const GenerateImageIvokeParamsSchema = OpenAIImageGenerationInput.extend({
  sessionId: z.string(),
  questId: z.string().optional(),
  organizationId: z.string().nullable().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
  fabFileIds: z.array(z.string()).prefault([]),
  tools: z.array(z.union([b4mLLMTools, z.string()])).optional(),
  /** Resolved by the API route's prompt resolver. Defaults to 'fresh' for first-turn or sessions with no prior image. */
  intent: PromptIntentSchema.optional(),
  promptEnhancement: z
    .object({
      originalPrompt: z.string(),
      enhancedPrompt: z.string(),
      promptWasEnhanced: z.boolean(),
      /** Resolver intent - drives the banner's framing (continuation = "context applied" vs fresh = "enhanced"). */
      intent: PromptIntentSchema.optional(),
    })
    .optional(),
});
export type GenerateImageIvokeParams = z.infer<typeof GenerateImageIvokeParamsSchema>;

export const GenerateImageRequestBodySchema = GenerateImageIvokeParamsSchema.extend({
  sessionId: z.string().optional(),
  sessionName: z.string().optional(),
  projectId: z.string().optional(),
});
export type GenerateImageRequestBody = z.infer<typeof GenerateImageRequestBodySchema>;

export const GenerateImageToolCallSchema = OpenAIImageGenerationInput.extend({
  safety_tolerance: z.number().optional(),
  prompt_upsampling: z.boolean().optional(),
  output_format: z.enum(['jpeg', 'png']).nullable().optional(),
  seed: z.number().nullable().optional(),
  editModel: z.string().optional(), // Model to use for image editing operations (separate from generation model)
}).omit({
  prompt: true,
});
export type GenerateImageToolCall = z.infer<typeof GenerateImageToolCallSchema>;

export const EditImageRequestBodySchema = OpenAIImageGenerationInput.extend({
  sessionId: z.string(),
  questId: z.string().optional(),
  organizationId: z.string().nullable().optional(),
  aspect_ratio: z.string().optional(),
  fabFileIds: z.array(z.string()).prefault([]),
  image: z.string(),
});

export const ChatCompletionInvokeParamsSchema = z.object({
  /** Notebook session ID */
  sessionId: z.string(),
  historyCount: z.number(),
  /** Epoch ms when the client submitted the prompt (for the request-lifecycle status log). */
  clientSubmittedAt: z.number().optional(),
  imageConfig: GenerateImageToolCallSchema.optional(),
  deepResearchConfig: z
    .object({
      maxDepth: z.number().optional(),
      duration: z.number().optional(),
      // Note: searchers are passed via ToolContext and not through this API schema
      searchers: z.array(z.any()).optional(),
    })
    .optional(),
  fabFileIds: z.array(z.string()),
  /** Prompt message */
  message: z.string(),
  messageFileIds: z.array(z.string()).prefault([]),
  questId: z.string().optional(),
  /** Extra context messages to include in the conversation from external sources */
  extraContextMessages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system', 'function', 'tool']),
        content: z.union([z.string(), z.array(z.any())]),
        fabFileIds: z.array(z.string()).optional(),
      })
    )
    .optional(),
  /** Dashboard related params */
  dashboardParams: DashboardParamsSchema.optional(),
  /** LLM params */
  params: ChatCompletionCreateInputSchema,
  /** Whether Quest Master is enabled */
  enableQuestMaster: z.boolean().optional(),
  /** Whether Mementos is enabled */
  enableMementos: z.boolean().optional(),
  /** Whether Artifacts is enabled */
  enableArtifacts: z.boolean().optional(),
  /** Whether Agents is enabled */
  enableAgents: z.boolean().optional(),
  /** Whether Lattice (financial pro-forma modeling) is enabled */
  enableLattice: z.boolean().optional(),
  /** LLM tools to enable (built-in tools or MCP tool names) */
  tools: z.array(z.union([b4mLLMTools, z.string()])).optional(),
  /** Enabled MCP servers */
  mcpServers: z.array(z.string()).optional(),
  /** Project ID */
  projectId: z.string().optional(),
  /** Organization ID */
  organizationId: z.string().nullable().optional(),
  /** Tool prompt ID to use for the LLM */
  toolPromptId: z.string().optional(),
  /** Quest Master related params */
  questMaster: QuestMasterParamsSchema.optional(),
  /** Research Mode related params */
  researchMode: ResearchModeParamsSchema.optional(),
  /** Fallback model ID to try if primary model fails */
  fallbackModel: z.string().optional(),
  /** Embedding model to use */
  embeddingModel: z.string().optional(),
  /** User's timezone (IANA format, e.g., "America/New_York") */
  timezone: z.string().optional(),
  /** Persona-based sub-agent filter - only these agent names are available for delegation */
  allowedAgents: z.array(z.string()).optional(),
  /** When true, Quest Processor injects Slack-specific tool configs (help, notebooks, curated files) */
  enableSlackTools: z.boolean().optional(),
  /**
   * Agent-mode toggle state forwarded from the composer. The chat
   * completion path itself does not branch on this - that decision happens
   * upstream in `routeQuery()` on the client (and, post-M4, on the server).
   * Plumbed through so telemetry and future per-decision routing logs can
   * attribute the choice to its source (manual toggle vs. classifier vs.
   * mention) without re-deriving it.
   */
  agentMode: z
    .object({
      enabled: z.boolean(),
      source: z.enum(['toggle', 'classifier', 'mention', 'user-default', 'agent_literal', 'complexity']),
    })
    .optional(),
});
export type ChatCompletionInvokeParams = z.infer<typeof ChatCompletionInvokeParamsSchema>;

export const LLMApiRequestBodySchema = ChatCompletionInvokeParamsSchema.extend({
  /** Notebook session ID */
  sessionId: z.string().optional(),
  /** Notebook session name */
  sessionName: z.string().optional(),
});
export type LLMApiRequestBody = z.infer<typeof LLMApiRequestBodySchema>;

// ============================================================================
// Prompt Caching Types (Provider-Agnostic)
// ============================================================================

import type { ModelBackend } from './models';

/**
 * Provider-agnostic cache strategy configuration
 * Works across all providers (Anthropic, OpenAI, Gemini, xAI, Bedrock)
 */
export interface ICacheStrategy {
  /** Master switch - enables caching for this request */
  enableCaching?: boolean;

  /** Cache system prompts/instructions */
  cacheSystemPrompt?: boolean;

  /** Cache tool definitions */
  cacheTools?: boolean;

  /** Cache conversation history */
  cacheConversationHistory?: boolean;

  /** Preferred TTL (only applicable to Anthropic, Bedrock) */
  cacheTTL?: '5m' | '1h';

  /** Optional conversation ID for xAI Grok cache affinity */
  conversationId?: string;

  /**
   * Provider-specific overrides (advanced usage)
   * For most cases, leave undefined and use auto-detection
   */
  providerHints?: {
    anthropic?: AnthropicCacheConfig;
    openai?: OpenAICacheConfig;
    gemini?: GeminiCacheConfig;
    xai?: XAICacheConfig;
  };
}

/**
 * Anthropic-specific cache configuration
 */
export interface AnthropicCacheConfig {
  /** Explicit cache_control placement */
  breakpoints?: ('tools' | 'system' | 'history')[];
  ttl?: '5m' | '1h';
}

/**
 * OpenAI-specific cache configuration
 * OpenAI caching is automatic - no config needed
 */
export interface OpenAICacheConfig {
  // Placeholder for future options
}

/**
 * Gemini-specific cache configuration
 */
export interface GeminiCacheConfig {
  /** Use explicit caching API (vs implicit) */
  useExplicitCache?: boolean;
  /** For reusing existing cache */
  cacheId?: string;
}

/**
 * xAI-specific cache configuration
 */
export interface XAICacheConfig {
  /** Conversation ID for cache affinity */
  conversationId?: string;
}

/**
 * Unified cache usage statistics (normalized across providers)
 */
export interface CacheUsageStats {
  provider: ModelBackend;
  model: string;

  // Token counts
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedTokens: number;

  // Performance metrics
  cacheHitRate: number; // 0-100%
  costSavingsPercent: number; // 0-100%
  estimatedLatencyReduction: number; // 0-100%

  // Provider-specific metadata
  providerMetadata?: Record<string, unknown>;
}
