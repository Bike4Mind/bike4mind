import {
  ChatCompletionCreateInputSchema,
  DashboardParamsSchema,
  PromptMetaZodSchema,
  b4mLLMTools,
  ResearchModeParamsSchema,
} from '@bike4mind/common';
import { z } from 'zod';

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
  enableMementos: z.boolean().optional(),
  enableArtifacts: z.boolean().optional(),
  promptMeta: PromptMetaZodSchema,
  embeddingModel: z.string().optional(),
  tools: z.array(z.union([b4mLLMTools, z.string()])).optional(),
  researchMode: ResearchModeParamsSchema.optional(),
  mcpServers: z.array(z.string()).optional(),
});
export type QuestStartBody = z.infer<typeof QuestStartBodySchema>;
