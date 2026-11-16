import { z } from 'zod';
import { MODEL_TIERS } from '../generation/modelRanking';
import { IMAGE_INPUT_ROLES } from '../image/types';
import { OpenAIImageQualitySchema } from './openai';
import { PublicImageSizingSchema } from './publicModel';

/**
 * The public projection of IMAGE_MODEL_CATALOG served by `GET /api/v1/image-models` (built by toPublicImageModel in
 * @bike4mind/server-utils/imageGenerations/listUsableImageModels). Wire fields are snake_case (CONVENTIONS.md
 * section 2), as on video_model and music_model.
 */

const AspectRatioCapabilitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('discrete'), values: z.array(z.string()) }),
  z.object({
    kind: z.literal('range'),
    tallest: z.string().describe('The tallest `W:H` ratio accepted.'),
    widest: z.string().describe('The widest `W:H` ratio accepted; every ratio between the two is accepted.'),
  }),
]);

const ImageModeCapabilitiesSchema = z.object({
  // Loose on purpose, as on video_model: a role added later must not make an older client drop the model.
  input_roles: z
    .array(z.object({ role: z.string(), max: z.number().int().positive(), required: z.boolean() }))
    .describe(
      `The input image roles this mode accepts, the most of each, and whether one is required. Roles today: ` +
        `${IMAGE_INPUT_ROLES.join(', ')}; ignore any you do not know.`
    ),
  max_outputs: z.number().int().positive().describe('The most images one request renders in this mode.'),
  aspect_ratios: AspectRatioCapabilitySchema.nullable().describe('null when the mode takes no `aspect_ratio`.'),
  output_formats: z
    .array(z.string())
    .describe('Accepted output formats; empty when none can be chosen and the provider default comes back.'),
});

export const ImageModelSchema = z.object({
  id: z.string(),
  object: z.literal('image_model'),
  display_name: z.string(),
  provider: z.string(),
  provider_label: z.string().describe('The provider as shown to people (`OpenAI`, `Black Forest Labs`). Display text.'),
  blurb: z.string().describe('One line on what the model is best at. Display text; may change.'),
  tier: z
    .enum(MODEL_TIERS)
    .describe("The model's quality class within its provider's line-up, best first. Not a price band."),
  released_at: z.string().describe("The provider's release date, `YYYY-MM-DD`."),
  preview: z.boolean().describe('Labelled preview by its provider: may change or be retired at short notice.'),
  modes: z
    .object({ generate: ImageModeCapabilitiesSchema.optional(), edit: ImageModeCapabilitiesSchema.optional() })
    .describe('What the model honours in each mode; a mode is offered exactly when it has an entry.'),
  sizing: PublicImageSizingSchema,
  qualities: z.array(OpenAIImageQualitySchema).describe('Accepted `quality` tiers; empty when it takes none.'),
  transparent_background: z.boolean().describe("Whether `background: 'transparent'` yields real alpha."),
  seed: z.boolean(),
  credits_per_image: z
    .number()
    .nullable()
    .describe(
      "Credits for one image at the model's default quality and size with no input images; null when unpriced. " +
        'Quality, size and input images change the price.'
    ),
  deprecation_date: z.string().nullable().describe('`YYYY-MM-DD`; null when no retirement is scheduled.'),
});
export type PublicImageModel = z.infer<typeof ImageModelSchema>;

export const ListImageModelsResponseSchema = z.object({
  models: z
    .array(ImageModelSchema)
    .describe(
      'Best first for a plain text-to-image request: generally available before preview, then flagship tier ' +
        'first, then newest release first.'
    ),
});
