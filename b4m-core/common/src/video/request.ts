import { z } from 'zod';
import { VideoModelIdSchema } from './catalog';
import { ASPECT_RATIOS, RESOLUTION_TIERS, VIDEO_INPUT_ROLES, VIDEO_MODES } from './types';

export const VIDEO_INPUTS_MAX = 8;

// Strict, so an entry naming both sources matches neither branch and is rejected.
export const VideoInputSchema = z.union([
  z.strictObject({ role: z.enum(VIDEO_INPUT_ROLES), fileId: z.string().min(1) }),
  // A generated-image storage key (quest.images): a chat image that is not a Files entry. Set only by the chat
  // agent's video_generation tool; the public API takes file ids only. Its format is checked by the owner lookup,
  // so a malformed key reads as not found like any other unresolvable one.
  z.strictObject({ role: z.enum(VIDEO_INPUT_ROLES), generatedImageKey: z.string().min(1) }),
]);
export type VideoInput = z.infer<typeof VideoInputSchema>;

export const VideoGenerationRequestSchema = z.object({
  model: VideoModelIdSchema,
  mode: z.enum(VIDEO_MODES),
  prompt: z.string().trim().min(1).max(4000),
  durationSeconds: z.number().positive(),
  aspectRatio: z.enum(ASPECT_RATIOS),
  resolution: z.enum(RESOLUTION_TIERS),
  inputs: z.array(VideoInputSchema).max(VIDEO_INPUTS_MAX).optional(),
  // Legacy single-image form, read as one first_frame input by videoRequestInputs. Kept so job payloads stored
  // before `inputs` existed still read, and older callers still parse. New code sets `inputs`.
  inputImageFileId: z.string().min(1).optional(),
  inputGeneratedImageKey: z.string().min(1).optional(),
  audio: z.boolean().optional(),
});
export type VideoGenerationRequest = z.infer<typeof VideoGenerationRequestSchema>;

/** Where an input image lives: an uploaded FabFile, or a generated image in the generated bucket. */
export type VideoInputImageRef = { kind: 'file'; id: string } | { kind: 'generated'; key: string };

export const videoInputRef = (input: VideoInput): VideoInputImageRef =>
  'fileId' in input ? { kind: 'file', id: input.fileId } : { kind: 'generated', key: input.generatedImageKey };

type RequestInputFields = Pick<VideoGenerationRequest, 'inputs' | 'inputImageFileId' | 'inputGeneratedImageKey'>;

/**
 * The request's input images, with the legacy single-image fields read as a first_frame input. The one read path
 * for inputs: validateAgainstCapabilities rejects a request that mixes the two forms, so nothing is dropped here.
 */
export const videoRequestInputs = (request: RequestInputFields): VideoInput[] => {
  if (request.inputs) return request.inputs;
  if (request.inputImageFileId) return [{ role: 'first_frame', fileId: request.inputImageFileId }];
  if (request.inputGeneratedImageKey)
    return [{ role: 'first_frame', generatedImageKey: request.inputGeneratedImageKey }];
  return [];
};

declare const validatedBrand: unique symbol;
// Only validateAgainstCapabilities produces this, so a provider can never receive an unchecked request.
export type ValidatedVideoRequest = VideoGenerationRequest & { readonly [validatedBrand]: true };
