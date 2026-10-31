import {
  toPublicMusicJobErrorCode,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type MusicGeneration,
  type MusicJobPublicErrorCode,
} from '@bike4mind/common';
import {
  OUTPUT_URL_TTL_SECONDS,
  outputUrlExpiresAt,
  toIso,
  type JobMapperDeps,
} from '@bike4mind/server-utils/generations/signedOutput';

// Fixed text per public code: a stored job.error.message can carry provider wording, which never leaves the server.
const PUBLIC_ERROR_MESSAGES: Record<MusicJobPublicErrorCode, string> = {
  content_blocked: 'The provider declined to generate this song under its content policy.',
  provider_timeout: 'The provider did not finish the song in time.',
  provider_error: 'The provider failed to generate the song.',
  region_unavailable: 'This model is not available in your region.',
  output_too_large: 'The generated song exceeded the maximum size.',
  cancelled: 'The generation was cancelled.',
};

const toPublicError = (error: IGenerationJobDocument['error']): MusicGeneration['error'] => {
  if (!error) return null;
  const code = toPublicMusicJobErrorCode(error.code);
  return { code, message: PUBLIC_ERROR_MESSAGES[code] };
};

/** The one job -> public resource mapping, shared by every music-generations endpoint. */
export async function toPublicMusicGeneration(
  job: IGenerationJobDocumentOf<'music'>,
  deps: JobMapperDeps
): Promise<MusicGeneration> {
  const { request, output } = job.payload;
  const signed = job.state === 'succeeded' && output ? await deps.sign(output, OUTPUT_URL_TTL_SECONDS) : null;
  return {
    id: job.id,
    object: 'music_generation',
    state: job.state,
    model: request.model,
    prompt: request.prompt,
    lyrics: request.lyrics ?? null,
    instrumental: request.instrumental,
    duration_seconds: request.durationSeconds,
    source: job.source,
    error: toPublicError(job.error),
    output:
      signed && output
        ? {
            availability: signed.availability,
            url: signed.availability === 'ready' ? signed.url : null,
            expires_at: signed.availability === 'ready' ? outputUrlExpiresAt(deps.now()) : null,
            content_type: output.contentType,
            duration_seconds: output.durationSeconds,
            lyrics: output.lyrics ?? null,
            file_id: output.fileId ?? null,
          }
        : null,
    credits: { reserved: job.creditHold?.reservedCredits ?? null, settled: job.settledCredits ?? null },
    created_at: toIso(job.createdAt),
    updated_at: toIso(job.updatedAt),
  };
}
