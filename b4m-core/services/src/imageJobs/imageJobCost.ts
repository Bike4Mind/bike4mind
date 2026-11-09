import { imageJobInputs, type StoredImageRequest } from '@bike4mind/common';
import { estimateImageUsd } from '../imageCost';

/**
 * USD for the one image a job renders. A mask is not billed as an input image, matching the chat edit path, so the
 * job and chat price the same request the same way.
 */
export const estimateImageJobUsd = (request: StoredImageRequest): number => {
  // The request schema refuses a repeated file, so each non-mask input is one image sent and billed.
  const inputImageCount = imageJobInputs(request).filter(input => input.role !== 'mask').length;
  return estimateImageUsd(request.model, 1, {
    model: request.model,
    quality: request.quality,
    size: request.size,
    inputImageCount,
  });
};
