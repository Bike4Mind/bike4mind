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

// Changelog section schema with type safety
export const ChangelogSectionSchema = z.object({
  type: z.enum(['features', 'fixes', 'improvements', 'breaking', 'other']),
  items: z.array(z.string()),
});
export type ChangelogSection = z.infer<typeof ChangelogSectionSchema>;

export const WhatsNewGenerationPayloadSchema = z.object({
  // Date-based deduplication for daily batching (always provided by cron + backfill)
  generatedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),

  // NEW: Multiple releases in one modal (daily batch)
  releases: z
    .array(
      z.object({
        tag: z.string(),
        name: z.string(),
        publishedAt: z.string(),
        body: z.string().optional(),
      })
    )
    .optional(),

  // NEW: Changelog context from AI generation
  changelogData: z
    .object({
      title: z.string(),
      briefSummary: z.array(z.string()),
      sections: z.array(ChangelogSectionSchema),
    })
    .optional(),

  // BACKWARD COMPATIBILITY: Keep old single-release fields
  releaseTag: z.string().optional(),
  releaseName: z.string().optional(),
  releaseBody: z.string().optional(),

  repositoryUrl: z.string(),
  commits: z.array(
    z.object({
      sha: z.string().optional(),
      message: z.string(),
      author: z.string().optional(),
      date: z.string().optional(),
    })
  ),
  pullRequests: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      body: z.string().nullable(),
      mergedAt: z.string().optional(),
      url: z.string().optional(),
      author: z.string().optional(),
    })
  ),
  changelogExcerpt: z.string().optional(),
  correlationId: z.string(),
  environment: z.enum(['dev', 'production']),
});
export type WhatsNewGenerationPayload = z.infer<typeof WhatsNewGenerationPayloadSchema>;
