import { z } from 'zod';
import { GenerateImageToolCallSchema, PromptIntentSchema } from '../llm';
import type { IChatHistoryItemDocument, ISessionDocument } from '../types/entities/SessionTypes';

// The typed prompt may run past what a job takes; the route truncates the prompt it sends to IMAGE_JOB_PROMPT_MAX_CHARS.
const CHAT_IMAGE_PROMPT_MAX_CHARS = 32_000;

const FileIdSchema = z.string().regex(/^[0-9a-f]{24}$/, 'must be a file id');

const ChatImageJobsBaseSchema = z.object({
  prompt: z.string().trim().min(1).max(CHAT_IMAGE_PROMPT_MAX_CHARS),
  sessionId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  /** Re-runs this quest of the session in place (a chat retry) instead of adding a turn. */
  questId: z.string().min(1).optional(),
  /** The chat's saved image selection (model, size, quality, ...); the server maps it to a job request. */
  selection: GenerateImageToolCallSchema,
  /** Images to make; clamped to what one request may start. */
  count: z.number().optional(),
  organizationId: z.string().nullable().optional(),
});

/**
 * POST /api/image-jobs: a notebook chat send with an image model selected, or the in-chat masked edit. Creates the
 * chat turn (quest) and its image generation jobs, which the chat renders as job cards.
 */
export const ChatImageJobsBodySchema = z.discriminatedUnion('mode', [
  ChatImageJobsBaseSchema.extend({
    mode: z.literal('generate'),
    /** Rewrites a self-contained prompt too; a continuation is always rewritten. */
    promptEnhancement: z.boolean().optional(),
    /** Files attached to the send (notebook context and message attachments); the images among them are inputs. */
    fileIds: z.array(z.string()).max(64).optional(),
  }),
  ChatImageJobsBaseSchema.extend({
    mode: z.literal('edit'),
    /** A FabFile the caller owns, already scanned clean. */
    editSourceFileId: FileIdSchema,
    maskFileId: FileIdSchema.optional(),
    /**
     * Which of editSourceFileId and maskFileId this send made only for the edit (the painted mask, a copy of the shown
     * image): the server deletes those once the edit's jobs end. Any other id is ignored.
     */
    temporaryFileIds: z.array(FileIdSchema).max(2).optional(),
  }),
]);
export type ChatImageJobsBody = z.infer<typeof ChatImageJobsBodySchema>;

/** The started job as the chat reads it back; its card polls GET /api/image-jobs/[id] for the rest. */
export type ChatImageJobSummary = { id: string; groupId: string | null; state: string };

export type ChatImageJobsResponse = {
  quest: IChatHistoryItemDocument;
  session: ISessionDocument;
  originalPrompt: string;
  enhancedPrompt: string;
  promptWasEnhanced: boolean;
  /** Set for a generation, whose prompt is resolved against the notebook; an edit takes its prompt literally. */
  intent?: z.infer<typeof PromptIntentSchema>;
  groupId: string;
  jobs: ChatImageJobSummary[];
};
