import { z } from 'zod';
import { ChatQuestPollResultSchema } from './chat';
import { PromptMetaZodSchema } from './promptMeta';

export const QuestIdParamSchema = z.object({
  id: z.string().min(1).describe('The quest id returned by POST /api/chat or another async start.'),
});

const GeneratedFileSchema = z.object({
  name: z.string(),
  url: z.string(),
  isImage: z.boolean(),
  isAudio: z.boolean(),
});

/**
 * Response of GET /api/v1/quests/{id}. Extends the outcome subset the async chat and image
 * ACKs already publish (ChatQuestPollResultSchema) with the rest of what the handler returns.
 * `pending` is written before a quest starts running and is non-terminal, like `running`.
 */
export const QuestPollResponseSchema = ChatQuestPollResultSchema.extend({
  status: z.enum(['pending', 'running', 'done', 'stopped']).optional(),
  sessionId: z.string(),
  images: z.array(z.string()),
  files: z.array(GeneratedFileSchema),
  // Loose: tool payloads are a heterogeneous union with no shared Zod shape.
  toolPayloads: z.array(z.unknown()),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional(),
  promptMeta: PromptMetaZodSchema.optional(),
  attachmentNotices: z.array(z.string()).optional(),
  // Loose: mirrors IAttachmentDelivery (requested, delivered, fullyDelivered, dropped, droppedIds).
  attachmentDelivery: z.record(z.string(), z.unknown()).optional(),
  executionTracking: z.unknown().optional(),
});

export type QuestPollResponse = z.infer<typeof QuestPollResponseSchema>;
