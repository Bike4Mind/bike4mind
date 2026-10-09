import { z } from 'zod';
import { ModelBackend, type ModelInfo } from '../models';
import type { ImageModelCapabilities, ImageSizing } from '../utils/imageCapabilities';
import { OpenAIImageQualitySchema } from './openai';
import { paginatedResponseSchema } from './pagination';

/**
 * The public projection of `ModelInfo` served by `GET /api/v1/models`.
 *
 * Deliberately narrower than `ModelInfo`: every field here is one an integrator can pin, so
 * internal catalog fields (`adapterFamily`, `dispatchProfile`, `rank`, `pricing`, `logoFile`)
 * stay off the wire. The legacy `GET /api/models` keeps serving the full internal type to the
 * SPA and CLI. Wire fields are snake_case (CONVENTIONS.md section 2).
 */

const PublicImageSizingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('presets'),
    presets: z.array(z.string()).describe('Accepted `size` values, as `WxH`.'),
    default_size: z.string(),
  }),
  z.object({
    kind: z.literal('constrained'),
    presets: z.array(z.string()).describe('Suggested `size` values; any `WxH` meeting `constraints` is accepted.'),
    default_size: z.string(),
    auto_size: z.string().describe('The `size` value that lets the provider choose.'),
    constraints: z.object({
      max_edge: z.number().int(),
      min_total_pixels: z.number().int(),
      max_total_pixels: z.number().int(),
      edge_multiple: z.number().int().describe('Both edges must be a multiple of this.'),
      max_aspect_ratio: z.number().describe('Longest edge divided by shortest edge.'),
    }),
  }),
  z.object({
    kind: z.literal('dimensions'),
    presets: z.array(z.string()),
    default_size: z.string(),
    min_width: z.number().int(),
    max_width: z.number().int(),
    min_height: z.number().int(),
    max_height: z.number().int(),
    step: z.number().int().describe('`width` and `height` are rounded to the nearest multiple of this.'),
  }),
  z.object({ kind: z.literal('aspect_ratio').describe('Takes an `aspect_ratio` such as `16:9`, not a `size`.') }),
  z.object({
    kind: z.literal('input_image').describe('Sized by the input image; takes no `size`.'),
    aspect_ratio: z.boolean().describe('Whether an `aspect_ratio` override is honoured.'),
  }),
  z.object({ kind: z.literal('fixed').describe('The provider takes no size at all.') }),
]);

export const PublicImageCapabilitiesSchema = z.object({
  sizing: PublicImageSizingSchema,
  supports: z.object({
    transparent_background: z.boolean().describe("`background: 'transparent'` yields real alpha."),
    seed: z.boolean(),
    qualities: z.array(OpenAIImageQualitySchema).describe('Accepted `quality` tiers; empty when none is taken.'),
    max_images: z.number().int().describe('Most images one request may ask for via `n`.'),
    max_reference_images: z
      .number()
      .int()
      .describe('Most `referenceImageFabFileIds` honoured; 0 when the model takes none.'),
    edit: z.boolean().describe('Accepted by `POST /api/v1/image-edits`.'),
    requires_input_image: z.boolean(),
  }),
});

export const PublicModelSchema = z.object({
  id: z.string().describe('Pass as `model` on the generation endpoints.'),
  name: z.string(),
  type: z.enum(['text', 'image', 'speech-to-text', 'video']),
  backend: z.enum(ModelBackend).describe('The provider that serves the model.'),
  description: z.string().nullable(),
  context_window: z.number().int().describe('Input context, in tokens.'),
  max_output_tokens: z.number().int(),
  supports_streaming: z.boolean(),
  supports_thinking: z.boolean(),
  supports_tools: z.boolean(),
  supports_vision: z.boolean(),
  deprecation_date: z.string().nullable().describe('`YYYY-MM-DD`; null when no retirement is scheduled.'),
  replaced_by: z.string().nullable().describe('The id of the recommended successor, when there is one.'),
  image: PublicImageCapabilitiesSchema.nullable().describe(
    'Size rules and supported parameters. Present on image models only; null for every other type.'
  ),
});

export const ListModelsResponseSchema = paginatedResponseSchema(PublicModelSchema);

export type PublicImageCapabilities = z.infer<typeof PublicImageCapabilitiesSchema>;
export type PublicModel = z.infer<typeof PublicModelSchema>;

type PublicImageSizing = PublicImageCapabilities['sizing'];

function toPublicImageSizing(sizing: ImageSizing): PublicImageSizing {
  switch (sizing.kind) {
    case 'presets':
      return { kind: 'presets', presets: [...sizing.presets], default_size: sizing.defaultSize };
    case 'constrained': {
      const { maxEdge, minTotalPixels, maxTotalPixels, edgeMultiple, maxAspectRatio } = sizing.constraints;
      return {
        kind: 'constrained',
        presets: [...sizing.presets],
        default_size: sizing.defaultSize,
        auto_size: sizing.autoSize,
        constraints: {
          max_edge: maxEdge,
          min_total_pixels: minTotalPixels,
          max_total_pixels: maxTotalPixels,
          edge_multiple: edgeMultiple,
          max_aspect_ratio: maxAspectRatio,
        },
      };
    }
    case 'dimensions':
      return {
        kind: 'dimensions',
        presets: [...sizing.presets],
        default_size: sizing.defaultSize,
        min_width: sizing.minWidth,
        max_width: sizing.maxWidth,
        min_height: sizing.minHeight,
        max_height: sizing.maxHeight,
        step: sizing.step,
      };
    case 'aspectRatio':
      return { kind: 'aspect_ratio' };
    case 'inputImage':
      return { kind: 'input_image', aspect_ratio: sizing.aspectRatio };
    case 'fixed':
      return { kind: 'fixed' };
  }
}

function toPublicImageCapabilities(image: ImageModelCapabilities): PublicImageCapabilities {
  const { supports } = image;
  return {
    sizing: toPublicImageSizing(image.sizing),
    supports: {
      transparent_background: supports.transparentBackground,
      seed: supports.seed,
      qualities: [...supports.qualities],
      max_images: supports.maxImages,
      max_reference_images: supports.maxReferenceImages,
      edit: supports.edit,
      requires_input_image: supports.requiresInputImage,
    },
  };
}

export function toPublicModel(model: ModelInfo): PublicModel {
  return {
    id: model.id,
    name: model.name,
    type: model.type,
    backend: model.backend,
    description: model.description ?? null,
    context_window: model.contextWindow,
    max_output_tokens: model.max_tokens,
    supports_streaming: model.can_stream ?? false,
    supports_thinking: model.can_think ?? false,
    supports_tools: model.supportsTools ?? false,
    supports_vision: model.supportsVision ?? false,
    deprecation_date: model.deprecationDate ?? null,
    replaced_by: model.replacedBy ?? null,
    image: model.image ? toPublicImageCapabilities(model.image) : null,
  };
}
