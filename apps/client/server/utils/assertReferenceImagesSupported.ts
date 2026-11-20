import { getMaxEditReferenceImages, getMaxReferenceImages, takesBflInputImageList } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

/**
 * Reject unsupported reference images before any work is queued. For FLUX.2 / FLUX 3 generation the
 * primary (`inputFabFileIds`) shares the cap with the references, so both are counted together.
 */
export function assertReferenceImagesSupported(
  model: string,
  referenceImageFabFileIds: string[] | undefined,
  operation: 'generate' | 'edit' = 'edit',
  inputFabFileIds?: string[]
): void {
  if (!referenceImageFabFileIds?.length) return;
  const limit = operation === 'generate' ? getMaxReferenceImages(model) : getMaxEditReferenceImages(model);
  if (!limit) {
    throw new BadRequestError(`referenceImageFabFileIds is not supported by model "${model}" for ${operation}`);
  }
  const sharesCap = operation === 'generate' && takesBflInputImageList(model);
  const distinct = new Set(
    sharesCap ? [...(inputFabFileIds ?? []), ...referenceImageFabFileIds] : referenceImageFabFileIds
  );
  if (distinct.size > limit) {
    throw new BadRequestError(
      sharesCap
        ? `fabFileIds plus referenceImageFabFileIds accept at most ${limit} images in total for model "${model}"`
        : `referenceImageFabFileIds accepts at most ${limit} images for model "${model}"`
    );
  }
}
