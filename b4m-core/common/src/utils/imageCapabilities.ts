import { IMAGE_SIZE_CONSTRAINTS, ImageModels } from '../models';
import {
  LEGACY_IMAGE_QUALITY_ALIASES,
  MAX_IMAGES_PER_REQUEST,
  OPENAI_IMAGE_QUALITIES,
  type OpenAIImageQuality,
} from '../schemas/openai';
import {
  IMAGES_PER_EDIT_REQUEST,
  MAX_REFERENCE_IMAGES,
  isBflImageModel,
  isBflUltraImageModel,
  isExtendedGptImageQuality,
  isGPTImage25Model,
  isGPTImage2Model,
  isGPTImageModel,
  isGeminiImageModel,
  isKontextModel,
  rejectsTransparentBackground,
  requiresImageInput,
  supportsImageEdit,
  usesDiscreteImageDimensions,
} from './modelHelpers';

/**
 * How a model is sized, as advertised on `ModelInfo.image` in GET /api/models.
 *
 * - `presets`: one of the listed `WxH` strings.
 * - `constrained`: a preset, `autoSize`, or any `WxH` meeting `constraints`
 *   (see satisfiesGptImage2Constraints).
 * - `dimensions`: discrete `width`/`height` within the bounds. Each is rounded to the nearest
 *   multiple of `step` before it is sent (resolveImageDimensions), presets included.
 * - `aspectRatio`: an `aspect_ratio` string such as `16:9`; the provider picks the pixels.
 * - `inputImage`: sized by the input image, so no `size` is taken. `aspectRatio` says whether an
 *   `aspect_ratio` string is honoured as an override (Kontext forwards it; Fill does not).
 * - `fixed`: the provider takes no size at all.
 */
export type ImageSizing =
  | { kind: 'presets'; presets: readonly string[]; defaultSize: string }
  | {
      kind: 'constrained';
      presets: readonly string[];
      defaultSize: string;
      autoSize: string;
      constraints: (typeof IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2)['constraints'];
    }
  | {
      kind: 'dimensions';
      presets: readonly string[];
      defaultSize: string;
      minWidth: number;
      maxWidth: number;
      minHeight: number;
      maxHeight: number;
      step: number;
    }
  | { kind: 'aspectRatio' }
  | { kind: 'inputImage'; aspectRatio: boolean }
  | { kind: 'fixed' };

export type ImageModelCapabilities = {
  sizing: ImageSizing;
  supports: {
    /** `background: 'transparent'` yields real alpha. */
    transparentBackground: boolean;
    seed: boolean;
    /** Accepted `quality` tiers; empty when the model takes no quality. */
    qualities: readonly OpenAIImageQuality[];
    /** Most images one generation request may ask for via `n`. */
    maxImages: number;
    /** Most `referenceImageFabFileIds` honoured; 0 when they are ignored. */
    maxReferenceImages: number;
    edit: boolean;
    requiresInputImage: boolean;
  };
};

function resolveSizing(model: ImageModels): ImageSizing {
  if (isGPTImage2Model(model)) {
    const { sizes, defaultSize, autoSize, constraints } = IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2;
    return { kind: 'constrained', presets: sizes, defaultSize, autoSize, constraints };
  }
  if (isGPTImageModel(model)) {
    const { sizes, defaultSize } = IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1;
    return { kind: 'presets', presets: sizes, defaultSize };
  }
  if (model === ImageModels.DALL_E_2) {
    const { sizes, defaultSize } = IMAGE_SIZE_CONSTRAINTS.DALL_E_2;
    return { kind: 'presets', presets: sizes, defaultSize };
  }
  if (usesDiscreteImageDimensions(model)) {
    const { sizes, defaultSize, minWidth, maxWidth, minHeight, maxHeight, stepSize } = IMAGE_SIZE_CONSTRAINTS.BFL;
    return {
      kind: 'dimensions',
      presets: sizes,
      defaultSize,
      minWidth,
      maxWidth,
      minHeight,
      maxHeight,
      step: stepSize,
    };
  }
  // Must stay in sync with the Kontext transform branch in ImageGeneration, which forwards aspect_ratio.
  if (requiresImageInput(model)) return { kind: 'inputImage', aspectRatio: isKontextModel(model) };
  if (isBflUltraImageModel(model) || isGeminiImageModel(model)) return { kind: 'aspectRatio' };
  return { kind: 'fixed' };
}

function resolveQualities(model: ImageModels): readonly OpenAIImageQuality[] {
  if (!isGPTImageModel(model)) return [];
  return OPENAI_IMAGE_QUALITIES.filter(
    quality =>
      !(LEGACY_IMAGE_QUALITY_ALIASES as readonly string[]).includes(quality) &&
      (isGPTImage25Model(model) || !isExtendedGptImageQuality(quality))
  );
}

/**
 * The size rules and supported params of an image model, derived from IMAGE_SIZE_CONSTRAINTS and
 * the modelHelpers predicates the request path enforces, so the advertised block cannot drift
 * from what a request is validated against.
 */
export function getImageModelCapabilities(model: ImageModels): ImageModelCapabilities {
  return {
    sizing: resolveSizing(model),
    supports: {
      transparentBackground: isGPTImageModel(model) && !rejectsTransparentBackground(model),
      // OpenAIImageService forwards a seed, but OpenAI's image API documents none to honour it.
      seed: isBflImageModel(model),
      qualities: resolveQualities(model),
      maxImages: requiresImageInput(model) ? IMAGES_PER_EDIT_REQUEST : MAX_IMAGES_PER_REQUEST,
      maxReferenceImages: isGPTImageModel(model) ? MAX_REFERENCE_IMAGES : 0,
      edit: supportsImageEdit(model),
      requiresInputImage: requiresImageInput(model),
    },
  };
}
