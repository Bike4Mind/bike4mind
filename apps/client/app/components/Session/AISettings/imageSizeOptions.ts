import {
  IMAGE_MODELS,
  IMAGE_SIZE_CONSTRAINTS,
  getImageModelCapabilities,
  isSupportedImageSize,
  type ImageModels,
  type ImageSizing,
} from '@bike4mind/common';

/**
 * What the Image Size dropdown offers and defaults to, for both surfaces that render it:
 * `ImageGenerationModelSelectionModal` (the image-gen gear modal) and `AdvancedAIModal`
 * (the model details dialog). They carried a copy each, and the copies drifted - the size
 * fix landed in the first and left the second rendering a blank Select.
 *
 * Presentation only, read from `getImageModelCapabilities(model).sizing` in `@bike4mind/common`
 * so the picker and `ModelInfo.image` on GET /api/models cannot disagree. Whether a size may be
 * *sent* is `isSupportedImageSize`, which this defers to rather than re-deriving.
 */

/**
 * The model's sizing, or undefined for an id the catalog does not know. `resolveSizing` answers
 * `fixed` for any id it does not recognize, so `fixed` is only trusted for a real catalog model
 * (Grok); prefix-matched ids such as a dated gpt-image snapshot resolve to their family first.
 */
const sizingOf = (model?: string | null): ImageSizing | undefined => {
  if (!model) return undefined;
  const { sizing } = getImageModelCapabilities(model as ImageModels);
  if (sizing.kind === 'fixed' && !(IMAGE_MODELS as readonly string[]).includes(model)) return undefined;
  return sizing;
};

/**
 * Whether the Image Size row renders for `model`. Hidden for the sizing kinds that take no size:
 * `aspectRatio` (Flux Ultra, Gemini), `inputImage` (Kontext, Fill) and `fixed` (Grok). Gemini
 * does turn a size into a ratio when Aspect Ratio is Auto; that control covers it.
 * An unrecognized model keeps the row, on the BFL presets below.
 */
export const showsImageSizeRow = (model?: string | null): boolean => {
  const sizing = sizingOf(model);
  return !sizing || 'presets' in sizing;
};

/**
 * The preset sizes listed for `model`; empty when the row is hidden. An unrecognized model gets
 * the BFL presets, as it always has.
 */
export const getImageSizePresets = (model?: string | null): readonly string[] => {
  const sizing = sizingOf(model);
  if (!sizing) return IMAGE_SIZE_CONSTRAINTS.BFL.sizes;
  return 'presets' in sizing ? sizing.presets : [];
};

/**
 * The presets for `model`, plus `size` itself when the model accepts it but does not list it.
 *
 * gpt-image-2 takes any resolution meeting its constraints, so a model switch can legitimately
 * leave a size with no matching `<Option>` - 'auto', or a 1280x960 carried over from a BFL model.
 * Joy draws a Select blank when its value matches no option and no placeholder is passed, which
 * hides what the user is about to generate at. Restricted to `constrained` sizing (the gpt-image-2
 * family): a `presets` model accepts only what it lists, and `isSupportedImageSize` measures
 * OpenAI tiers only, so a BFL size put through it would be tested against the wrong list.
 */
export const getAvailableImageSizes = (model?: string | null, size?: string | null): readonly string[] => {
  const presets = getImageSizePresets(model);
  if (size && !presets.includes(size) && sizingOf(model)?.kind === 'constrained' && isSupportedImageSize(model, size)) {
    return [...presets, size];
  }
  return presets;
};

/**
 * What the dropdown shows when no size is set. Not `fallbackImageSize` from common: that answers
 * the OpenAI-only question of what to *send*, and has no BFL tier.
 *
 * An unrecognized model deliberately falls back to the GPT-Image-1 default rather than the BFL one
 * it gets presets from. Preserved from both originals, and harmless because 1024x1024 is in the
 * BFL preset list too - so the value still matches an option.
 */
export const defaultImageSize = (model?: string | null): string => {
  const sizing = sizingOf(model);
  return sizing && 'defaultSize' in sizing ? sizing.defaultSize : IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize;
};
