import { ImageModels } from '../models';
import { z } from 'zod';

/**
 * Constants for BFL safety tolerance settings.
 *
 * BFL scale: 0 = strictest filtering, 6 = effectively unfiltered. MAX is a
 * hard cap (18 U.S.C. 2258A exposure) - enforced in the zod schemas
 * here AND clamped last-mile in BFLImageService, so no caller can raise it.
 * BFL itself caps its editing endpoints at 2.
 */
export const BFL_SAFETY_TOLERANCE = {
  MIN: 0,
  MAX: 2,
  DEFAULT: 2,
  /** Pre-cap sessions may have stored up to 6 - accepted as input, clamped to MAX on parse. */
  LEGACY_INPUT_MAX: 6,
} as const;

/**
 * Shared safety_tolerance schema: accepts the legacy 0-6 stored range but
 * clamps the parsed output to the hard cap (coerce, not reject - rejecting
 * would break image generation for sessions saved before the cap existed).
 */
export const BFLSafetyToleranceSchema = z
  .number()
  .min(BFL_SAFETY_TOLERANCE.MIN)
  .max(BFL_SAFETY_TOLERANCE.LEGACY_INPUT_MAX)
  .optional()
  .prefault(BFL_SAFETY_TOLERANCE.DEFAULT)
  .transform(value => Math.min(value, BFL_SAFETY_TOLERANCE.MAX));

/**
 * List of image models supported by BlackForest Labs
 */
export const BFL_IMAGE_MODELS = [
  ImageModels.FLUX_PRO_1_1, // Current standard model
  ImageModels.FLUX_PRO, // Deprecated - kept for backwards compatibility
  ImageModels.FLUX_PRO_ULTRA,
  // TODO: Support the full set of BFL Features
  // This model is technically connected and live but needs more UI support
  ImageModels.FLUX_PRO_FILL,
  ImageModels.FLUX_KONTEXT_PRO,
  ImageModels.FLUX_KONTEXT_MAX,
] as const;

/**
 * Type representing all BFL image model options
 */
export type BFLImageModel = (typeof BFL_IMAGE_MODELS)[number];

// Common parameters shared between models
const CommonBFLParams = z.object({
  prompt: z.string().nullable().optional(),
  safety_tolerance: BFLSafetyToleranceSchema,
  output_format: z.enum(['jpeg', 'png']).nullable().optional().prefault('jpeg'),
  image_prompt: z.string().nullable().optional(),
  webhook_url: z.string().min(1).max(2083).nullable().optional(),
  webhook_secret: z.string().nullable().optional(),
});

// Flux Pro specific parameters
export const FluxProInputSchema = CommonBFLParams.extend({
  width: z.number().min(256).max(1440).prefault(1024),
  height: z.number().min(256).max(1440).prefault(768),
  steps: z.number().min(1).max(50).prefault(40).nullable().optional(),
  prompt_upsampling: z.boolean().prefault(false),
  seed: z.number().nullable().optional(),
  guidance: z.number().min(1.5).max(5).prefault(2.5).nullable().optional(),
  interval: z.number().min(1).max(4).prefault(2).nullable().optional(),
});

// Flux Ultra specific parameters
export const FluxUltraInputSchema = CommonBFLParams.extend({
  prompt_upsampling: z.boolean().prefault(false),
  seed: z.number().nullable().optional(),
  aspect_ratio: z.string().prefault('16:9'),
  raw: z.boolean().prefault(false),
  image_prompt_strength: z.number().min(0).max(1).prefault(0.1),
});

// Flux Kontext specific parameters (image-to-image transformation)
export const FluxKontextInputSchema = CommonBFLParams.extend({
  input_image: z.string().min(1), // Required base64 encoded input image
  prompt_upsampling: z.boolean().prefault(false),
  seed: z.number().nullable().optional(),
  aspect_ratio: z.string().optional(), // Optional aspect ratio override
});

export type FluxProInput = z.infer<typeof FluxProInputSchema>;
export type FluxUltraInput = z.infer<typeof FluxUltraInputSchema>;
export type FluxKontextInput = z.infer<typeof FluxKontextInputSchema>;

// Combined type for all BFL inputs
export type BFLImageGenerationOptions = (FluxProInput | FluxUltraInput | FluxKontextInput) & {
  n?: number;
  user?: string;
  model?: string;
};
