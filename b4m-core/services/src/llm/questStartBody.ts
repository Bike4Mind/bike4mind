/**
 * The quest-start request schema.
 *
 * Kept in its own leaf module (deps: zod + @bike4mind/common only) because
 * apps/client's server/utils/eventBus.ts needs it to type two event payloads,
 * and eventBus is imported by hundreds of API routes. Defining it in
 * ChatCompletionFeatures.ts instead would make every one of those routes trace
 * ChatCompletionProcess and the whole tool registry into its bundle, since
 * @vercel/nft follows files rather than used bindings.
 * Re-exported from ChatCompletionFeatures.ts, so the public surface is unchanged.
 * See services/src/index.closure.test.ts.
 */
import { z } from 'zod';
import {
  ChatCompletionCreateInputSchema,
  DashboardParamsSchema,
  PromptMetaZodSchema,
  b4mLLMTools,
  QuestMasterParamsSchema,
  ResearchModeParamsSchema,
  GenerateImageToolCallSchema,
  AudioGenerationToolCallSchema,
  PROMPT_TEXT_MAX,
} from '@bike4mind/common';

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
  /** See ChatCompletionInvokeParamsSchema.promptMode - must stay in sync with it. */
  promptMode: z.enum(['raw', 'grounded', 'surface']).optional(),
  /** See ChatCompletionInvokeParamsSchema.skipAutoOffers - must stay in sync with it. */
  skipAutoOffers: z.boolean().optional(),
  /** See ChatCompletionInvokeParamsSchema.systemPrompt - must stay in sync with it. */
  systemPrompt: z.string().max(PROMPT_TEXT_MAX).optional(),
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
  audioConfig: AudioGenerationToolCallSchema.optional(),
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
  /**
   * Disclose the system prompt text this completion was assembled from. Exposed on the process
   * instance for the direct response of the request that asked for it, and never persisted -
   * the derived breakdown (`promptMeta.context.systemPromptDetails`) is the persisted half.
   */
  includeSystemPrompt: z.boolean().optional(),
});
