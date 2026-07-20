import { ImageModels } from '@bike4mind/common';
import { isImageModel } from '@client/app/utils/commands';

/**
 * Image EDITING / inpainting models. Their prompts are edit instructions
 * ("change X, keep Y"), not scene-building, so the guided prompt builder (which
 * assembles a subject/scene/style description) doesn't apply to them.
 */
const IMAGE_EDIT_MODELS = new Set<string>([
  ImageModels.FLUX_KONTEXT_PRO,
  ImageModels.FLUX_KONTEXT_MAX,
  ImageModels.FLUX_PRO_FILL,
]);

/** True for text-to-image GENERATION models (image models minus editing/inpainting). */
export function isImageGenerationModel(model: string): boolean {
  return isImageModel(model) && !IMAGE_EDIT_MODELS.has(model);
}
