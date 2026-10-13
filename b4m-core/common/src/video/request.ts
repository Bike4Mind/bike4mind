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
  // A generated-image storage key (quest.images). Set only by the chat agent's video_generation tool: the
  // public API maps its body field by field and never sets it. Its format is checked by the owner lookup,
  // so a malformed key reads as not found like any other unresolvable one.
  inputGeneratedImageKey: z.string().min(1).optional(),
  audio: z.boolean().optional(),
});
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

/** Where an image_to_video input lives: an uploaded FabFile, or a generated image in the generated bucket. */
export type VideoInputImageRef = { kind: 'file'; id: string } | { kind: 'generated'; key: string };

/** The request's input image, if any. validateAgainstCapabilities guarantees at most one is set. */
export const videoInputImageRef = (
  request: Pick<VideoGenerationRequest, 'inputImageFileId' | 'inputGeneratedImageKey'>
): VideoInputImageRef | null => {
  if (request.inputImageFileId) return { kind: 'file', id: request.inputImageFileId };
  if (request.inputGeneratedImageKey) return { kind: 'generated', key: request.inputGeneratedImageKey };
  return null;
};

declare const validatedBrand: unique symbol;
// Only validateAgainstCapabilities produces this, so a provider can never receive an unchecked request.
export type ValidatedVideoRequest = VideoGenerationRequest & { readonly [validatedBrand]: true };
