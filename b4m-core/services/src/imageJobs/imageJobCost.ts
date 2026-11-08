import { imageJobInputs, type StoredImageRequest } from '@bike4mind/common';
import { estimateImageUsd } from '../imageCost';

/**
 * USD for the one image a job renders. A mask is not billed as an input image, matching the chat edit path, so the
 * job and chat price the same request the same way.
 */
export const estimateImageJobUsd = (request: StoredImageRequest): number => {
  // The same file twice is one input image, as the chat path counts it.
  const billedFileIds = imageJobInputs(request).flatMap(input => (input.role === 'mask' ? [] : [input.fileId]));
  const inputImageCount = new Set(billedFileIds).size;
  return estimateImageUsd(request.model, 1, {
    model: request.model,
    quality: request.quality,
    size: request.size,
    inputImageCount,
  });
};
