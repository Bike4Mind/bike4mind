import { getMaxEditReferenceImages, getMaxReferenceImages } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

/** Reject unsupported reference images before any work is queued. */
export function assertReferenceImagesSupported(
  model: string,
  referenceImageFabFileIds: string[] | undefined,
  operation: 'generate' | 'edit' = 'edit'
): void {
  if (!referenceImageFabFileIds?.length) return;
  const limit = operation === 'generate' ? getMaxReferenceImages(model) : getMaxEditReferenceImages(model);
  if (!limit) {
    throw new BadRequestError(`referenceImageFabFileIds is not supported by model "${model}" for ${operation}`);
  }
  if (new Set(referenceImageFabFileIds).size > limit) {
    throw new BadRequestError(`referenceImageFabFileIds accepts at most ${limit} images for model "${model}"`);
  }
}
