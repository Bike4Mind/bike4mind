import {
  ChatCompletionCreateInputSchema,
  DashboardParamsSchema,
  OpenAIImageGenerationInput,
  PromptMetaZodSchema,
  b4mLLMTools,
  ResearchModeParamsSchema,
} from '@bike4mind/common';
import { z } from 'zod';

export const ImageGenerationBodySchema = OpenAIImageGenerationInput.extend({
  sessionId: z.string(),
  questId: z.string(),
  userId: z.string(),
  prompt: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  aspect_ratio: z.string().optional(),
});
export type ImageGenerationBody = z.infer<typeof ImageGenerationBodySchema>;

export const QuestStartBodySchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  questId: z.string(),
  organizationId: z.string().optional(),
  message: z.string(),
  messageFileIds: z.array(z.string()),
  historyCount: z.number(),
  fabFileIds: z.array(z.string()),
  params: ChatCompletionCreateInputSchema,
  dashboardParams: DashboardParamsSchema.optional(),
  enableQuestMaster: z.boolean().optional(),
  enableMementos: z.boolean().optional(),
  enableArtifacts: z.boolean().optional(),
  promptMeta: PromptMetaZodSchema,
  embeddingModel: z.string().optional(),
  tools: z.array(z.union([b4mLLMTools, z.string()])).optional(),
  researchMode: ResearchModeParamsSchema.optional(),
  mcpServers: z.array(z.string()).optional(),
});
export type QuestStartBody = z.infer<typeof QuestStartBodySchema>;
