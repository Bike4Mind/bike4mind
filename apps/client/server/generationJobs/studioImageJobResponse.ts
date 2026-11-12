/** The Studio image-job response shape, shared by the image-jobs and cutouts routes. */
import type { GenerationJobErrorCode, IGenerationJobDocumentOf } from '@bike4mind/common';
import type { CreateImageJobsResult } from '@bike4mind/services/imageJobs';

type ImageJob = IGenerationJobDocumentOf<'image'>;

// Fixed text per code: a stored job.error.message can carry provider wording, which never leaves the server.
const PUBLIC_ERROR_MESSAGES: Record<GenerationJobErrorCode, string> = {
  content_blocked: 'The image was declined under the content policy.',
  provider_timeout: 'The provider did not finish the image in time.',
  provider_error: 'The provider failed to generate the image.',
  orphaned_submit: 'The image could not be completed.',
  region_unavailable: 'This model is not available in your region.',
  output_too_large: 'The generated image exceeded the maximum size.',
  input_image_not_found: 'An input image could not be found.',
  enqueue_failed: 'The image could not be started.',
  cancelled: 'The generation was cancelled.',
  account_blocked: 'This account cannot generate images.',
};

/** The fields Studio reads; credit holds, provider errors and lease state stay server-side. */
export const toStudioImageJob = (job: ImageJob) => ({
  id: job.id,
  groupId: job.payload.groupId ?? null,
  purpose: job.payload.purpose ?? null,
  state: job.state,
  request: job.payload.request,
  error: job.error ? { code: job.error.code, message: PUBLIC_ERROR_MESSAGES[job.error.code] } : null,
  output: job.payload.output
    ? {
        fileId: job.payload.output.fileId ?? null,
        contentType: job.payload.output.contentType,
        bytes: job.payload.output.bytes,
      }
    : null,
  createdAt: job.createdAt,
});

export const imageJobRefusalBody = (refusal: Extract<CreateImageJobsResult, { ok: false }>) => ({
  error: refusal.code,
  message: refusal.message,
  ...(refusal.code === 'unsupported_by_model' && { failures: refusal.failures }),
  ...(refusal.code === 'storage_quota_exceeded' && { storage: refusal.storage }),
});
