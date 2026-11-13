import { z } from 'zod';
import { BflEditRegionsSchema } from '../llm';
import { ImageModels } from '../models';
import { ImageOutputFormatSchema, OpenAIImageQualitySchema, LocalImageModelIdSchema } from '../schemas/openai';
import { IMAGE_INPUT_ROLES, IMAGE_MODES, TEST_IMAGE_MODEL, type LocalImageModelId } from './types';

export const IMAGE_JOB_PROMPT_MAX_CHARS = 4000;
// Bounds the payload, not the model: validateImageRequest enforces each model's per-role cap.
export const IMAGE_JOB_INPUTS_MAX = 16;

// A FabFile the requester owns. Strict, so a stray field (a URL, a generated key) is rejected, not ignored.
export const ImageJobInputSchema = z.strictObject({
  role: z.enum(IMAGE_INPUT_ROLES),
  fileId: z.string().regex(/^[0-9a-f]{24}$/, 'fileId must be a file id'),
});
export type ImageJobInput = z.infer<typeof ImageJobInputSchema>;

/**
 * One image to render, as an image generation job stores it. One job is one image: "make N" is N jobs, so a
 * job's request carries no count. `model` is exactly what was asked for; nothing downstream swaps it.
 */
export const ImageJobRequestSchema = z.strictObject({
  model: z.union([
    z.enum(ImageModels),
    z.literal(TEST_IMAGE_MODEL),
    z.custom<LocalImageModelId>(value => LocalImageModelIdSchema.safeParse(value).success),
  ]),
  mode: z.enum(IMAGE_MODES),
  prompt: z.string().trim().min(1).max(IMAGE_JOB_PROMPT_MAX_CHARS),
  inputs: z
    .array(ImageJobInputSchema)
    .max(IMAGE_JOB_INPUTS_MAX)
    .refine(inputs => new Set(inputs.map(input => input.fileId)).size === inputs.length, 'each file may be used once')
    .optional(),
  size: z.string().min(1).optional(),
  aspectRatio: z.string().min(1).optional(),
  quality: OpenAIImageQualitySchema.optional(),
  outputFormat: ImageOutputFormatSchema.optional(),
  transparentBackground: z.boolean().optional(),
  seed: z.number().int().nonnegative().optional(),
  /** Edit-only regions to change, each with its own instruction; the model's catalog entry says whether it takes them. */
  editRegions: BflEditRegionsSchema.min(1).optional(),
});
export type ImageJobRequest = z.infer<typeof ImageJobRequestSchema>;

/**
 * The request as persisted on the job: validated against the model, with the quality pinned to the tier it is
 * billed and rendered at (see resolveBilledImageQuality in @bike4mind/services), so the hold and the render agree.
 */
export type StoredImageRequest = ImageJobRequest;

export const imageJobInputs = (request: Pick<ImageJobRequest, 'inputs'>): readonly ImageJobInput[] =>
  request.inputs ?? [];
