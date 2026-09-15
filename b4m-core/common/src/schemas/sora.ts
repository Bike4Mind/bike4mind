import { z } from 'zod';
import { VIDEO_SIZE_CONSTRAINTS, VideoModels } from '../models';

/**
 * OpenAI Sora Video Generation Schemas
 *
 * Reference: https://platform.openai.com/docs/api-reference/videos
 */

/**
 * Available Sora video models
 */
export const SORA_VIDEO_MODELS = [VideoModels.SORA_2, VideoModels.SORA_2_PRO] as const;

/**
 * Valid video durations in seconds
 */
export const SORA_VIDEO_DURATIONS = VIDEO_SIZE_CONSTRAINTS.SORA.durations;

/**
 * Valid video sizes (width x height)
 */
export const SORA_VIDEO_SIZES = VIDEO_SIZE_CONSTRAINTS.SORA.sizes;

/**
 * Sora video generation input schema
 */
export const SoraVideoInputSchema = z.object({
  /** Text description of the video to generate */
  prompt: z.string().min(1).max(10000),

  /** Model to use for generation */
  model: z.enum(VideoModels).prefault(VideoModels.SORA_2),

  /** Video duration in seconds: 4, 8, or 12 */
  seconds: z.union([z.literal(4), z.literal(8), z.literal(12)]).prefault(4),

  /** Video resolution */
  size: z
    .enum(['720x1280', '1280x720', '1024x1792', '1792x1024'] as const)
    .prefault(VIDEO_SIZE_CONSTRAINTS.SORA.defaultSize),

  /** Optional user identifier for abuse tracking */
  user: z.string().optional(),
});

export type SoraVideoInput = z.infer<typeof SoraVideoInputSchema>;

/**
 * Sora video generation response schema (job submission)
 */
export const SoraVideoJobResponseSchema = z.object({
  /** Unique identifier for the video generation job */
  id: z.string(),

  /** Current status of the job */
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']),

  /** Error message if the job failed */
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
    })
    .optional(),

  /** Timestamp when the job was created */
  created_at: z.number().optional(),
});

export type SoraVideoJobResponse = z.infer<typeof SoraVideoJobResponseSchema>;

/**
 * Sora video result schema (after completion)
 */
export const SoraVideoResultSchema = z.object({
  /** Unique identifier for the video */
  id: z.string(),

  /** Status should be 'completed' */
  status: z.literal('completed'),

  /** URL to download the video (temporary, expires after a period) */
  video_url: z.url().optional(),

  /** Video duration in seconds */
  duration: z.number().optional(),

  /** Video resolution */
  resolution: z.string().optional(),
});

export type SoraVideoResult = z.infer<typeof SoraVideoResultSchema>;

/**
 * Schema for video generation API request body
 */
export const GenerateVideoRequestBodySchema = z.object({
  prompt: z.string().min(1),
  model: z.enum(VideoModels).optional().prefault(VideoModels.SORA_2),
  seconds: z
    .union([z.literal(4), z.literal(8), z.literal(12)])
    .optional()
    .prefault(4),
  size: z
    .enum(['720x1280', '1280x720', '1024x1792', '1792x1024'] as const)
    .optional()
    .prefault(VIDEO_SIZE_CONSTRAINTS.SORA.defaultSize),
  sessionId: z.string().optional(),
  sessionName: z.string().optional(),
  questId: z.string().optional(),
  projectId: z.string().optional(),
  organizationId: z.string().nullable().optional(),
});

export type GenerateVideoRequestBody = z.infer<typeof GenerateVideoRequestBodySchema>;

/**
 * Schema for video generation invoke params (internal API)
 */
export const GenerateVideoInvokeParamsSchema = GenerateVideoRequestBodySchema.extend({
  sessionId: z.string(),
});

export type GenerateVideoInvokeParams = z.infer<typeof GenerateVideoInvokeParamsSchema>;
