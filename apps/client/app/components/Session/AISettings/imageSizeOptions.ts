import {
  IMAGE_SIZE_CONSTRAINTS,
  isBflImageModel,
  isGPTImage2Model,
  isGPTImageModel,
  isKontextModel,
  isSupportedImageSize,
} from '@bike4mind/common';

/**
 * What the Image Size dropdown offers and defaults to, for both surfaces that render it:
 * `ImageGenerationModelSelectionModal` (the image-gen gear modal) and `AdvancedAIModal`
 * (the model details dialog). They carried a copy each, and the copies drifted - the size
 * fix landed in the first and left the second rendering a blank Select.
 *
 * Presentation only. Whether a size may be *sent* is `isSupportedImageSize` in
 * `@bike4mind/common`, which this defers to rather than re-deriving.
 */

/**
 * The preset sizes listed for `model`. Kontext is sized by its input image and has none;
 * both callers already hide the row for it, so the empty list is a redundant guard.
 */
export const getImageSizePresets = (model?: string | null): readonly string[] => {
  if (isGPTImage2Model(model)) return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.sizes;
  if (isGPTImageModel(model)) return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.sizes;
  if (isKontextModel(model)) return [];
  return IMAGE_SIZE_CONSTRAINTS.BFL.sizes;
};

/**
 * The presets for `model`, plus `size` itself when the model accepts it but does not list it.
 *
 * gpt-image-2 takes any resolution meeting its constraints, so a model switch can legitimately
 * leave a size with no matching `<Option>` - 'auto', or a 1280x960 carried over from a BFL model.
 * Joy draws a Select blank when its value matches no option and no placeholder is passed, which
 * hides what the user is about to generate at. Restricted to GPT-Image because
 * `isSupportedImageSize` measures OpenAI tiers only; a BFL size put through it would be tested
 * against the wrong list.
 */
export const getAvailableImageSizes = (model?: string | null, size?: string | null): readonly string[] => {
  const presets = getImageSizePresets(model);
  if (size && !presets.includes(size) && isGPTImageModel(model) && isSupportedImageSize(model, size)) {
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
  if (isGPTImage2Model(model)) return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.defaultSize;
  if (isGPTImageModel(model)) return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize;
  if (isBflImageModel(model)) return IMAGE_SIZE_CONSTRAINTS.BFL.defaultSize;
  return IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_1.defaultSize;
};
