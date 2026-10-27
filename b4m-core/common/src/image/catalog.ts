import { IMAGE_SIZE_CONSTRAINTS, ImageModels } from '../models';
import { MAX_IMAGES_PER_REQUEST, type ImageOutputFormat, type OpenAIImageQuality } from '../schemas/openai';
import type { ImageSizing } from '../utils/imageCapabilities';
import { getMaxReferenceImages, IMAGES_PER_EDIT_REQUEST, MAX_REFERENCE_IMAGES } from '../utils/modelHelpers';
import type { AspectRatioCapability, ImageModeCapabilities, ImageModelCatalogEntry } from './types';

const GPT_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const satisfies readonly OpenAIImageQuality[];
const GPT_IMAGE_25_QUALITIES = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
] as const satisfies readonly OpenAIImageQuality[];
const ALL_FORMATS = ['png', 'jpeg', 'webp'] as const satisfies readonly ImageOutputFormat[];
// BFL has no webp; toNonWebpOutputFormat rewrites it to png today, which the table does not promise.
const PNG_JPEG = ['png', 'jpeg'] as const satisfies readonly ImageOutputFormat[];

// BFL documents aspect_ratio for Ultra and Kontext as anything between 21:9 and 9:21.
const BFL_ASPECT_RATIOS: AspectRatioCapability = { kind: 'range', tallest: '9:21', widest: '21:9' };

const GPT_IMAGE_1_SIZING: ImageSizing = {
  kind: 'presets',
  presets: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes,
  defaultSize: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize,
};
const GPT_IMAGE_2_SIZING: ImageSizing = {
  kind: 'constrained',
  presets: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes,
  defaultSize: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.defaultSize,
  autoSize: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.autoSize,
  constraints: IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.constraints,
};
const BFL_SIZING: ImageSizing = {
  kind: 'dimensions',
  presets: IMAGE_SIZE_CONSTRAINTS.BFL.sizes,
  defaultSize: IMAGE_SIZE_CONSTRAINTS.BFL.defaultSize,
  minWidth: IMAGE_SIZE_CONSTRAINTS.BFL.minWidth,
  maxWidth: IMAGE_SIZE_CONSTRAINTS.BFL.maxWidth,
  minHeight: IMAGE_SIZE_CONSTRAINTS.BFL.minHeight,
  maxHeight: IMAGE_SIZE_CONSTRAINTS.BFL.maxHeight,
  step: IMAGE_SIZE_CONSTRAINTS.BFL.stepSize,
};

// Every edit provider resolves to a single image whatever `n` asks for (IMAGES_PER_EDIT_REQUEST).
const editMode = (mode: Omit<ImageModeCapabilities, 'maxOutputs'>): ImageModeCapabilities => ({
  ...mode,
  maxOutputs: IMAGES_PER_EDIT_REQUEST,
});

// gpt-image takes up to MAX_REFERENCE_IMAGES style anchors in either mode (generation routes them through
// images.edit), and an optional mask that binds to the edit_source.
const gptImage = (
  overrides: Pick<ImageModelCatalogEntry, 'sizing' | 'qualities' | 'transparentBackground'>
): ImageModelCatalogEntry => ({
  provider: 'openai',
  modes: {
    generate: {
      inputs: { reference: { max: MAX_REFERENCE_IMAGES } },
      maxOutputs: MAX_IMAGES_PER_REQUEST,
      aspectRatios: null,
      outputFormats: ALL_FORMATS,
    },
    edit: editMode({
      inputs: { edit_source: { max: 1 }, mask: { max: 1 }, reference: { max: MAX_REFERENCE_IMAGES } },
      aspectRatios: null,
      outputFormats: ALL_FORMATS,
    }),
  },
  styles: [],
  seed: false,
  ...overrides,
});

// Flux Pro, 1.1 and Ultra forward one input image as BFL's `image_prompt` (Redux), which guides the
// generation without editing it: a reference, not an edit_source.
const bflGenerate = (aspectRatios: AspectRatioCapability | null): ImageModeCapabilities => ({
  inputs: { reference: { max: 1 } },
  maxOutputs: MAX_IMAGES_PER_REQUEST,
  aspectRatios,
  outputFormats: PNG_JPEG,
});

const bfl = (overrides: Pick<ImageModelCatalogEntry, 'modes' | 'sizing'>): ImageModelCatalogEntry => ({
  provider: 'bfl',
  qualities: [],
  styles: [],
  transparentBackground: false,
  seed: true,
  ...overrides,
});

// FLUX.2 forwards the workbench image and any referenceImageFabFileIds together as input_image..input_image_N,
// under one cap that counts all of them (getMaxReferenceImages). It has no edit dispatcher.
const flux2 = (model: ImageModels): ImageModelCatalogEntry =>
  bfl({
    modes: {
      generate: {
        inputs: { reference: { max: getMaxReferenceImages(model) } },
        maxOutputs: MAX_IMAGES_PER_REQUEST,
        aspectRatios: null,
        outputFormats: PNG_JPEG,
      },
    },
    sizing: BFL_SIZING,
  });

// The gemini-*-image models are not served by the Imagen-style generateImages call GeminiImageService tries
// first, so both modes land on generateContent with no imageConfig: no aspect ratio or format reaches Gemini.
// This is narrower than the `aspectRatio` sizing getImageModelCapabilities advertises (catalog.test.ts).
// On chat, a workbench image turns generate into image-to-image: ImageGeneration edits that one image `n`
// times, so it is a generate reference (as FLUX.1's image_prompt is), not a one-image edit_source.
const gemini = (): ImageModelCatalogEntry => ({
  provider: 'gemini',
  modes: {
    generate: {
      inputs: { reference: { max: 1 } },
      maxOutputs: MAX_IMAGES_PER_REQUEST,
      aspectRatios: null,
      outputFormats: [],
    },
    edit: editMode({ inputs: { edit_source: { max: 1 } }, aspectRatios: null, outputFormats: [] }),
  },
  sizing: { kind: 'fixed' },
  qualities: [],
  styles: [],
  transparentBackground: false,
  seed: false,
});

/**
 * Every ImageModels member, so adding one forces a declaration here. Each entry states what the model
 * honours, not what the request path coerces: a request outside it is meant to fail validation rather
 * than be stepped down. `styles` is empty everywhere because `style` only reaches dall-e-2, which ignores it.
 */
export const IMAGE_MODEL_CATALOG: Record<ImageModels, ImageModelCatalogEntry> = {
  [ImageModels.GPT_IMAGE_1]: gptImage({
    sizing: GPT_IMAGE_1_SIZING,
    qualities: GPT_IMAGE_QUALITIES,
    transparentBackground: true,
  }),
  [ImageModels.GPT_IMAGE_1_5]: gptImage({
    sizing: GPT_IMAGE_1_SIZING,
    qualities: GPT_IMAGE_QUALITIES,
    transparentBackground: true,
  }),
  [ImageModels.GPT_IMAGE_1_MINI]: gptImage({
    sizing: GPT_IMAGE_1_SIZING,
    qualities: GPT_IMAGE_QUALITIES,
    transparentBackground: true,
  }),
  // The API rejects `background: 'transparent'`. The request path steps such a request down to gpt-image-1.5
  // (rejectsTransparentBackground); declaring it here lets a caller fail it instead.
  [ImageModels.GPT_IMAGE_2]: gptImage({
    sizing: GPT_IMAGE_2_SIZING,
    qualities: GPT_IMAGE_QUALITIES,
    transparentBackground: false,
  }),
  [ImageModels.GPT_IMAGE_2_5_SUNBURST]: gptImage({
    sizing: GPT_IMAGE_2_SIZING,
    qualities: GPT_IMAGE_25_QUALITIES,
    transparentBackground: true,
  }),
  [ImageModels.GPT_IMAGE_2_5_FLARE]: gptImage({
    sizing: GPT_IMAGE_2_SIZING,
    qualities: GPT_IMAGE_25_QUALITIES,
    transparentBackground: true,
  }),
  // Unreachable through the API (LEGACY_IMAGE_MODEL_MAP rewrites it to gpt-image-2) and has no ModelInfo row.
  // It drops output_format and returns png. Its variation endpoint is not modelled.
  [ImageModels.DALL_E_2]: {
    provider: 'openai',
    modes: { generate: { inputs: {}, maxOutputs: MAX_IMAGES_PER_REQUEST, aspectRatios: null, outputFormats: ['png'] } },
    sizing: {
      kind: 'presets',
      presets: IMAGE_SIZE_CONSTRAINTS.DALL_E_2.sizes,
      defaultSize: IMAGE_SIZE_CONSTRAINTS.DALL_E_2.defaultSize,
    },
    qualities: [],
    styles: [],
    transparentBackground: false,
    seed: false,
  },
  [ImageModels.FLUX_PRO]: bfl({ modes: { generate: bflGenerate(null) }, sizing: BFL_SIZING }),
  [ImageModels.FLUX_PRO_1_1]: bfl({ modes: { generate: bflGenerate(null) }, sizing: BFL_SIZING }),
  [ImageModels.FLUX_PRO_ULTRA]: bfl({
    modes: { generate: bflGenerate(BFL_ASPECT_RATIOS) },
    sizing: { kind: 'aspectRatio' },
  }),
  // Inpainting only: the mask is mandatory and the output takes the edit_source's size.
  [ImageModels.FLUX_PRO_FILL]: bfl({
    modes: {
      edit: editMode({
        inputs: { edit_source: { max: 1 }, mask: { max: 1, required: true } },
        aspectRatios: null,
        outputFormats: PNG_JPEG,
      }),
    },
    sizing: { kind: 'inputImage', aspectRatio: false },
  }),
  // Image-to-image instruction edits, dispatched through BFL's transform path rather than the edit endpoint.
  [ImageModels.FLUX_KONTEXT_PRO]: bfl({
    modes: {
      edit: editMode({ inputs: { edit_source: { max: 1 } }, aspectRatios: BFL_ASPECT_RATIOS, outputFormats: PNG_JPEG }),
    },
    sizing: { kind: 'inputImage', aspectRatio: true },
  }),
  [ImageModels.FLUX_KONTEXT_MAX]: bfl({
    modes: {
      edit: editMode({ inputs: { edit_source: { max: 1 } }, aspectRatios: BFL_ASPECT_RATIOS, outputFormats: PNG_JPEG }),
    },
    sizing: { kind: 'inputImage', aspectRatio: true },
  }),
  [ImageModels.FLUX_2_MAX]: flux2(ImageModels.FLUX_2_MAX),
  [ImageModels.FLUX_2_PRO]: flux2(ImageModels.FLUX_2_PRO),
  [ImageModels.FLUX_2_PRO_PREVIEW]: flux2(ImageModels.FLUX_2_PRO_PREVIEW),
  [ImageModels.FLUX_2_FLEX]: flux2(ImageModels.FLUX_2_FLEX),
  [ImageModels.FLUX_2_KLEIN_9B]: flux2(ImageModels.FLUX_2_KLEIN_9B),
  [ImageModels.FLUX_2_KLEIN_9B_PREVIEW]: flux2(ImageModels.FLUX_2_KLEIN_9B_PREVIEW),
  [ImageModels.FLUX_2_KLEIN_4B]: flux2(ImageModels.FLUX_2_KLEIN_4B),
  // xAI receives only the prompt and n; it takes no size, ratio or format and has no edit endpoint.
  [ImageModels.GROK_IMAGINE_IMAGE_QUALITY]: {
    provider: 'xai',
    modes: { generate: { inputs: {}, maxOutputs: MAX_IMAGES_PER_REQUEST, aspectRatios: null, outputFormats: [] } },
    sizing: { kind: 'fixed' },
    qualities: [],
    styles: [],
    transparentBackground: false,
    seed: false,
  },
  [ImageModels.GEMINI_2_5_FLASH_IMAGE]: gemini(),
  [ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW]: gemini(),
  [ImageModels.GEMINI_3_1_FLASH_IMAGE]: gemini(),
  [ImageModels.GEMINI_3_PRO_IMAGE]: gemini(),
};

export const getImageModelCatalogEntry = (model: ImageModels): ImageModelCatalogEntry => IMAGE_MODEL_CATALOG[model];
