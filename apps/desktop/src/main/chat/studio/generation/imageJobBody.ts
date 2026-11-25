import { CreateImageJobBodySchema, type CreateImageJobBody, type ImageJobRequest } from '@bike4mind/common';

/**
 * Studio plans an image in the domain shape (ImageJobRequest, camelCase); POST /api/v1/image-jobs takes the public
 * snake_case body with `count` beside it. The inverse of toDomainRequest in apps/client/pages/api/v1/image-jobs.
 * The payer is not set here: MediaApiClient adds organization_id at submit.
 */
export function toCreateImageJobBody(request: ImageJobRequest, count: number): CreateImageJobBody {
  // The public route has no BFL provider settings; dropping them quietly would render a different image.
  if (request.safetyTolerance !== undefined || request.promptUpsampling !== undefined) {
    throw new Error('Studio image requests cannot carry provider safety or upsampling settings.');
  }
  return CreateImageJobBodySchema.parse({
    model: request.model,
    mode: request.mode,
    prompt: request.prompt,
    ...(request.inputs && { inputs: request.inputs.map(input => ({ role: input.role, file_id: input.fileId })) }),
    ...(request.size !== undefined && { size: request.size }),
    ...(request.aspectRatio !== undefined && { aspect_ratio: request.aspectRatio }),
    ...(request.quality !== undefined && { quality: request.quality }),
    ...(request.outputFormat !== undefined && { output_format: request.outputFormat }),
    ...(request.transparentBackground !== undefined && { transparent_background: request.transparentBackground }),
    ...(request.seed !== undefined && { seed: request.seed }),
    ...(request.editRegions && { edit_regions: request.editRegions }),
    count,
  });
}
