import { z } from 'zod';
import { VideoModelIdSchema } from './catalog';
import { ASPECT_RATIOS, RESOLUTION_TIERS, VIDEO_MODES } from './types';

export const VideoGenerationRequestSchema = z.object({
  model: VideoModelIdSchema,
  mode: z.enum(VIDEO_MODES),
  prompt: z.string().trim().min(1).max(4000),
  durationSeconds: z.number().positive(),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(RESOLUTION_TIERS),
  inputImageFileId: z.string().min(1).optional(),
  audio: z.boolean().optional(),
});
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

declare const validatedBrand: unique symbol;
// Only validateAgainstCapabilities produces this, so a provider can never receive an unchecked request.
export type ValidatedVideoRequest = VideoGenerationRequest & { readonly [validatedBrand]: true };
