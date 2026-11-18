/** The Studio render-job response shape for the Productions export routes (apps/client/pages/api/studio/compositions/[id]/renders.ts). */
import type { GenerationJobErrorCode, IGenerationJobDocumentOf, StudioRenderJob } from '@bike4mind/common';
import type { CreateRenderJobsResult } from '@bike4mind/services/renderJobs';

type RenderJob = IGenerationJobDocumentOf<'render'>;

// Fixed text per code: a stored job.error.message can carry worker or ffmpeg wording, which never leaves the server.
const PUBLIC_ERROR_MESSAGES: Record<GenerationJobErrorCode, string> = {
  content_blocked: 'The export was declined under the content policy.',
  provider_timeout: 'The export did not finish in time. Your credits were refunded.',
  provider_error: 'The export failed. Your credits were refunded.',
  orphaned_submit: 'The export could not be completed. Your credits were refunded.',
  region_unavailable: 'Exports are not available in your region.',
  output_too_large: 'The exported video is too large to store. Your credits were refunded.',
  input_image_not_found: 'A clip file could not be found. Your credits were refunded.',
  enqueue_failed: 'The export could not be started. Your credits were refunded.',
  cancelled: 'The export was cancelled. Your credits were refunded.',
  account_blocked: 'This account cannot export videos.',
  unsupported_input: 'A clip file could not be used for this export. Your credits were refunded.',
};

export const toStudioRenderJob = (job: RenderJob): StudioRenderJob => {
  const { request, groupId, output } = job.payload;
  return {
    id: job.id,
    groupId,
    compositionId: request.compositionId,
    state: job.state,
    progress: job.progress ?? null,
    output: request.output,
    heldCredits: job.creditHold?.reservedCredits ?? null,
    settledCredits: job.settledCredits ?? null,
    error: job.error ? { code: job.error.code, message: PUBLIC_ERROR_MESSAGES[job.error.code] } : null,
    file: output
      ? { fileId: output.fileId ?? null, bytes: output.bytes, durationSeconds: output.durationSeconds }
      : null,
    createdAt: (job.createdAt ?? new Date()).toISOString(),
  };
};

export const renderJobRefusalBody = (refusal: Extract<CreateRenderJobsResult, { ok: false }>) => ({
  error: refusal.code,
  message: refusal.message,
  ...(refusal.storage && { storage: refusal.storage }),
});
