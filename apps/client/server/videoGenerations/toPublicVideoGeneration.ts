import {
  toPublicVideoJobErrorCode,
  type IGenerationJobDocument,
  type VideoGeneration,
  type VideoJobOutput,
  type VideoJobPublicErrorCode,
} from '@bike4mind/common';

// Short enough that a leaked URL dies quickly; clients re-read the job (which re-signs) for a fresh one.
export const OUTPUT_URL_TTL_SECONDS = 900;

/** Resolves to null when the output must not be served yet (see signOutputUrl's moderation gate). */
export type SignOutputUrl = (
  output: Pick<VideoJobOutput, 'location' | 's3Key' | 'fileId'>,
  expiresInSeconds: number
) => Promise<string | null>;

// Fixed text per public code: a stored job.error.message can carry provider wording, which never leaves the server.
const PUBLIC_ERROR_MESSAGES: Record<VideoJobPublicErrorCode, string> = {
  content_blocked: 'The provider declined to generate this video under its content policy.',
  provider_timeout: 'The provider did not finish the video in time.',
  provider_error: 'The provider failed to generate the video.',
  region_unavailable: 'This model is not available in your region.',
  output_too_large: 'The generated video exceeded the maximum size.',
  input_image_not_found: 'The input image was not found.',
  cancelled: 'The generation was cancelled.',
};

const toIso = (date: Date | undefined): string => {
  if (!date) throw new Error('generation job has no timestamps');
  return new Date(date).toISOString();
};

const toPublicError = (error: IGenerationJobDocument['error']): VideoGeneration['error'] => {
  if (!error) return null;
  const code = toPublicVideoJobErrorCode(error.code);
  return { code, message: PUBLIC_ERROR_MESSAGES[code] };
};

/** The one job -> public resource mapping, shared by every video-generations endpoint. */
export async function toPublicVideoGeneration(
  job: IGenerationJobDocument,
  deps: { sign: SignOutputUrl; now: () => Date }
): Promise<VideoGeneration> {
  const { request, output } = job.payload;
  const url = job.state === 'succeeded' && output ? await deps.sign(output, OUTPUT_URL_TTL_SECONDS) : null;
  return {
    id: job.id,
    object: 'video_generation',
    state: job.state,
    model: request.model,
    mode: request.mode,
    prompt: request.prompt,
    duration_seconds: request.durationSeconds,
    aspect_ratio: request.aspectRatio,
    resolution: request.resolution,
    source: job.source,
    progress: job.progress ?? null,
    error: toPublicError(job.error),
    output:
      job.state === 'succeeded' && output
        ? {
            url,
            expires_at:
              url === null ? null : new Date(deps.now().getTime() + OUTPUT_URL_TTL_SECONDS * 1000).toISOString(),
            content_type: output.contentType,
            duration_seconds: output.durationSeconds,
            file_id: output.fileId ?? null,
          }
        : null,
    credits: { reserved: job.creditHold?.reservedCredits ?? null, settled: job.settledCredits ?? null },
    created_at: toIso(job.createdAt),
    updated_at: toIso(job.updatedAt),
  };
}
