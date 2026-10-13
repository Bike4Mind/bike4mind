import { isGPTImageModel } from '@bike4mind/common';
import { BadRequestError } from '@server/utils/errors';

/**
 * Reject `referenceImageFabFileIds` for a model that cannot carry them, before any work is queued.
 * Only gpt-image takes style anchors; the services drop them for every other model
 * (ImageGenerationService/ImageEditService.resolveReferenceImages), and a silent drop renders in an
 * unrelated style that a caller only notices when comparing a batch side by side.
 */
export function assertReferenceImagesSupported(model: string, referenceImageFabFileIds: string[] | undefined): void {
  if (!referenceImageFabFileIds?.length || isGPTImageModel(model)) return;

  throw new BadRequestError(
    `referenceImageFabFileIds is only supported by gpt-image models; model "${model}" cannot use reference images`
  );
}
