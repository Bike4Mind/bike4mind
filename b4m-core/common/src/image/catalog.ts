import { IMAGE_SIZE_CONSTRAINTS, ImageModels } from '../models';
import { MAX_IMAGES_PER_REQUEST, type ImageOutputFormat, type OpenAIImageQuality } from '../schemas/openai';
import type { ImageSizing } from '../utils/imageCapabilities';
import { IMAGES_PER_EDIT_REQUEST, MAX_REFERENCE_IMAGES } from '../utils/modelHelpers';
import type { AspectRatioCapability, ImageInputRole, ImageModelCatalogEntry } from './types';

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
// BFL and Gemini have no webp; toNonWebpOutputFormat rewrites it to png today, which the table does not promise.
const PNG_JPEG = ['png', 'jpeg'] as const satisfies readonly ImageOutputFormat[];

// BFL documents aspect_ratio for Ultra and Kontext as anything between 21:9 and 9:21.
const BFL_ASPECT_RATIOS: AspectRatioCapability = { kind: 'range', tallest: '9:21', widest: '21:9' };
// Gemini's documented imageConfig.aspectRatio values.
const GEMINI_ASPECT_RATIOS: AspectRatioCapability = {
  kind: 'discrete',
  values: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
};

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

// gpt-image edits through images.edit: one edit_source, an optional mask (bound to the first image) and up to
// MAX_REFERENCE_IMAGES style anchors, which generation carries too by routing through the same endpoint.
const gptImage = (overrides: Pick<ImageModelCatalogEntry, 'sizing' | 'qualities' | 'transparentBackground'>) =>
  ({
    provider: 'openai',
    modes: ['generate', 'edit'],
    inputs: { edit_source: { max: 1 }, mask: { max: 1 }, reference: { max: MAX_REFERENCE_IMAGES } },
    aspectRatios: null,
    styles: [],
    outputFormats: ALL_FORMATS,
    maxOutputs: MAX_IMAGES_PER_REQUEST,
    seed: false,
    ...overrides,
  }) satisfies ImageModelCatalogEntry;

const bfl = (overrides: Pick<ImageModelCatalogEntry, 'sizing' | 'aspectRatios'> & Partial<ImageModelCatalogEntry>) =>
  ({
    provider: 'bfl',
    modes: ['generate'],
    inputs: {},
    qualities: [],
    styles: [],
    outputFormats: PNG_JPEG,
    maxOutputs: MAX_IMAGES_PER_REQUEST,
    transparentBackground: false,
    seed: true,
    ...overrides,
  }) satisfies ImageModelCatalogEntry;

// Gemini edits one image through generateContent, with no mask and no reference images.
const gemini = (): ImageModelCatalogEntry => ({
  provider: 'gemini',
  modes: ['generate', 'edit'],
  inputs: { edit_source: { max: 1 } },
  sizing: { kind: 'aspectRatio' },
  aspectRatios: GEMINI_ASPECT_RATIOS,
  qualities: [],
  styles: [],
  outputFormats: PNG_JPEG,
  maxOutputs: MAX_IMAGES_PER_REQUEST,
  transparentBackground: false,
  seed: false,
});

/**
 * Every ImageModels member, so adding one forces a declaration here. Each entry states what the model
 * honours, not what the request path happens to coerce today: a value outside it is a validation
 * failure, never a silent step-down. `styles` is empty everywhere because `style` only reaches
 * dall-e-2, which ignores it.
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
    modes: ['generate'],
    inputs: {},
    sizing: {
      kind: 'presets',
      presets: IMAGE_SIZE_CONSTRAINTS.DALL_E_2.sizes,
      defaultSize: IMAGE_SIZE_CONSTRAINTS.DALL_E_2.defaultSize,
    },
    aspectRatios: null,
    qualities: [],
    styles: [],
    outputFormats: ['png'],
    maxOutputs: MAX_IMAGES_PER_REQUEST,
    transparentBackground: false,
    seed: false,
  },
  [ImageModels.FLUX_PRO]: bfl({ sizing: BFL_SIZING, aspectRatios: null }),
  [ImageModels.FLUX_PRO_1_1]: bfl({ sizing: BFL_SIZING, aspectRatios: null }),
  // Ultra's image_prompt input is not wired by the dispatcher, so it takes no reference.
  [ImageModels.FLUX_PRO_ULTRA]: bfl({ sizing: { kind: 'aspectRatio' }, aspectRatios: BFL_ASPECT_RATIOS }),
  // Inpainting only: the mask is mandatory and the output takes the edit_source's size.
  [ImageModels.FLUX_PRO_FILL]: bfl({
    modes: ['edit'],
    inputs: { edit_source: { max: 1 }, mask: { max: 1, required: true } },
    sizing: { kind: 'inputImage', aspectRatio: false },
    aspectRatios: null,
    maxOutputs: IMAGES_PER_EDIT_REQUEST,
  }),
  // Image-to-image instruction edits, dispatched through BFL's transform path rather than the edit endpoint.
  [ImageModels.FLUX_KONTEXT_PRO]: bfl({
    modes: ['edit'],
    inputs: { edit_source: { max: 1 } },
    sizing: { kind: 'inputImage', aspectRatio: true },
    aspectRatios: BFL_ASPECT_RATIOS,
    maxOutputs: IMAGES_PER_EDIT_REQUEST,
  }),
  [ImageModels.FLUX_KONTEXT_MAX]: bfl({
    modes: ['edit'],
    inputs: { edit_source: { max: 1 } },
    sizing: { kind: 'inputImage', aspectRatio: true },
    aspectRatios: BFL_ASPECT_RATIOS,
    maxOutputs: IMAGES_PER_EDIT_REQUEST,
  }),
  // xAI receives only the prompt and n; it takes no size, ratio or format and has no edit endpoint.
  [ImageModels.GROK_IMAGINE_IMAGE_QUALITY]: {
    provider: 'xai',
    modes: ['generate'],
    inputs: {},
    sizing: { kind: 'fixed' },
    aspectRatios: null,
    qualities: [],
    styles: [],
    outputFormats: [],
    maxOutputs: MAX_IMAGES_PER_REQUEST,
    transparentBackground: false,
    seed: false,
  },
  [ImageModels.GEMINI_2_5_FLASH_IMAGE]: gemini(),
  [ImageModels.GEMINI_3_PRO_IMAGE_PREVIEW]: gemini(),
  [ImageModels.GEMINI_3_1_FLASH_IMAGE]: gemini(),
  [ImageModels.GEMINI_3_PRO_IMAGE]: gemini(),
};

const isCatalogedImageModel = (model: string): model is ImageModels => Object.hasOwn(IMAGE_MODEL_CATALOG, model);

export const getImageModelCatalogEntry = (model: ImageModels): ImageModelCatalogEntry => IMAGE_MODEL_CATALOG[model];

/** How many inputs of `role` a model accepts; 0 for an uncatalogued id such as a `local-image/...` checkpoint. */
export function maxImageInputs(model: string, role: ImageInputRole): number {
  if (!isCatalogedImageModel(model)) return 0;
  return IMAGE_MODEL_CATALOG[model].inputs[role]?.max ?? 0;
}
